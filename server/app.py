"""FastAPI app: boards, assets, jobs, models; also serves the built web UI."""
from __future__ import annotations

import re
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .assets import AssetError, asset_path, save_image_bytes, thumbnail_path
from .config import ROOT, Settings, load_settings
from .db import Store
from .flow import FlowClient, FlowError, model_id
from .jobs import JobRunner

USER_RE = re.compile(r"^[\w一-鿿\- ]{1,32}$")


class JobRequest(BaseModel):
    board: Optional[str] = None
    node: Optional[str] = None
    model: str                      # model family key, e.g. gemini-3.1-flash-image
    ratio: str = "16:9"
    size: str = "1K"
    prompt: str = Field(min_length=1, max_length=20000)
    refs: list[str] = Field(default_factory=list, max_length=14)
    count: int = Field(default=1, ge=1, le=8)


class BoardBody(BaseModel):
    name: Optional[str] = Field(default=None, max_length=80)
    data: Optional[dict] = None


def allowed_catalog(settings: Settings, catalog: list[dict]) -> list[dict]:
    """Drop the models and resolutions the admin switched off in config.json."""
    out = []
    for m in catalog:
        if m["key"] in settings.disabled_models:
            continue
        sizes = [s for s in m["sizes"] if s not in settings.disabled_sizes]
        if sizes:
            out.append({**m, "sizes": sizes})
    return out


def create_app(settings: Optional[Settings] = None, flow: Optional[FlowClient] = None) -> FastAPI:
    settings = settings or load_settings()
    store = Store(settings.db_path)
    settings.assets_dir.mkdir(parents=True, exist_ok=True)
    flow = flow or FlowClient(settings.flow_base_url, settings.flow_api_key, timeout=settings.job_timeout)
    runner = JobRunner(settings, store, flow)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        store.fail_unfinished_jobs("服务重启，任务已中断")
        yield
        await runner.shutdown()
        await flow.close()

    app = FastAPI(title="Flow Canvas", lifespan=lifespan)
    app.state.settings, app.state.store, app.state.flow, app.state.runner = settings, store, flow, runner

    def decode_user(x_user: Optional[str] = Header(default=None)) -> str:
        from urllib.parse import unquote
        user = unquote((x_user or "").strip())
        if not USER_RE.match(user):
            raise HTTPException(401, "请先填写用户名（1–32 个字符）")
        return user

    user_dep = Depends(decode_user)

    # ---- misc
    @app.get("/api/health")
    async def health():
        info: dict = {"ok": True, "jobs": store.count_active_jobs()}
        try:
            info["flow"] = await flow.health()
        except Exception as exc:
            info["flow"] = {"error": f"{type(exc).__name__}"}
        return info

    @app.get("/api/models")
    async def models(refresh: bool = False):
        try:
            catalog = await flow.models(refresh=refresh)
            return {"models": allowed_catalog(settings, catalog), "max_count": settings.max_count}
        except (FlowError, httpx.HTTPError) as exc:
            raise HTTPException(502, f"无法读取模型列表：{exc}")

    # ---- boards
    @app.get("/api/boards")
    async def list_boards(user: str = user_dep):
        return {"boards": store.list_boards(user)}

    @app.post("/api/boards")
    async def create_board(body: BoardBody, user: str = user_dep):
        board = store.create_board(user, uuid.uuid4().hex[:12], (body.name or "未命名画板").strip() or "未命名画板")
        return board

    @app.get("/api/boards/{board_id}")
    async def get_board(board_id: str, user: str = user_dep):
        board = store.get_board(user, board_id)
        if not board:
            raise HTTPException(404, "画板不存在")
        return board

    @app.put("/api/boards/{board_id}")
    async def save_board(board_id: str, body: BoardBody, user: str = user_dep):
        if body.data is None and body.name is None:
            raise HTTPException(400, "没有要保存的内容")
        if body.data is not None:
            ok = store.save_board(user, board_id, body.data, body.name)
        else:
            ok = store.rename_board(user, board_id, body.name or "")
        if not ok:
            raise HTTPException(404, "画板不存在")
        return {"ok": True}

    @app.delete("/api/boards/{board_id}")
    async def delete_board(board_id: str, user: str = user_dep):
        if not store.delete_board(user, board_id):
            raise HTTPException(404, "画板不存在")
        return {"ok": True}

    # ---- assets
    @app.post("/api/assets")
    async def upload_asset(request: Request, user: str = user_dep):
        data = await request.body()
        try:
            return save_image_bytes(settings, store, data)
        except AssetError as exc:
            raise HTTPException(400, str(exc))

    @app.get("/api/assets/{asset_id}")
    async def get_asset(asset_id: str, w: Optional[int] = None, download: bool = False):
        meta = store.get_asset(asset_id) if re.fullmatch(r"[0-9a-f]{40}", asset_id) else None
        path = asset_path(settings, asset_id) if meta else None
        if not meta or not path or not path.exists():
            raise HTTPException(404, "图片不存在")
        headers = {"Cache-Control": "public, max-age=31536000, immutable"}
        if download:
            ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}.get(meta["mime"], "img")
            headers["Content-Disposition"] = f'attachment; filename="{asset_id[:12]}.{ext}"'
            return FileResponse(path, media_type=meta["mime"], headers=headers)
        if w:
            thumb = thumbnail_path(settings, asset_id, w)
            mime = meta["mime"] if thumb == path else "image/webp"
            return FileResponse(thumb, media_type=mime, headers=headers)
        return FileResponse(path, media_type=meta["mime"], headers=headers)

    # ---- jobs
    @app.post("/api/jobs")
    async def create_jobs(body: JobRequest, user: str = user_dep):
        if body.model in settings.disabled_models:
            raise HTTPException(400, "该模型已被管理员关闭")
        if body.size.strip().upper() in settings.disabled_sizes:
            raise HTTPException(400, f"{body.size} 分辨率已被管理员关闭")
        if body.count > settings.max_count:
            raise HTTPException(400, f"一次最多生成 {settings.max_count} 张")
        try:
            mid = model_id(body.model, body.ratio, body.size)
        except FlowError as exc:
            raise HTTPException(400, str(exc))
        for asset_id in body.refs:
            if not store.get_asset(asset_id):
                raise HTTPException(400, "参考图不存在，请重新添加")
        ids = runner.submit(user=user, board=body.board, node=body.node, model=mid,
                            prompt=body.prompt.strip(), refs=body.refs, count=body.count)
        return {"jobs": ids}

    @app.get("/api/jobs")
    async def get_jobs(ids: str, user: str = user_dep):
        wanted = [i for i in ids.split(",") if re.fullmatch(r"[0-9a-f]{16}", i)][:64]
        rows = [j for j in store.get_jobs(wanted) if j["user"] == user]
        out = []
        for j in rows:
            item = {k: j[k] for k in ("id", "node", "status", "progress", "error", "result_asset", "model")}
            asset = store.get_asset(j["result_asset"]) if j["result_asset"] else None
            item["result_w"], item["result_h"] = (asset["w"], asset["h"]) if asset else (None, None)
            out.append(item)
        return {"jobs": out}

    @app.post("/api/jobs/{job_id}/cancel")
    async def cancel_job(job_id: str, user: str = user_dep):
        job = store.get_job(job_id)
        if not job or job["user"] != user:
            raise HTTPException(404, "任务不存在")
        return {"cancelled": runner.cancel(job_id)}

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    # ---- web UI
    dist = ROOT / "web" / "dist"
    if dist.exists():
        app.mount("/", StaticFiles(directory=dist, html=True), name="web")
    return app
