"""FastAPI app: boards, assets, jobs, models; also serves the built web UI."""
from __future__ import annotations

import io
import json
import re
import sqlite3
import uuid
import zipfile
from urllib.parse import quote
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .assets import AssetError, asset_path, save_image_bytes, thumbnail_path
from .config import SIZE_ORDER, ROOT, Settings, load_settings
from .db import Store
from .flow import FlowClient, FlowError, model_id
from .jobs import JobRunner

USER_RE = re.compile(r"^[\w一-鿿\- ]{1,32}$")
ID_RE = re.compile(r"^[0-9a-f]{32}$")
AVATAR_RE = re.compile(r"^(emoji:.{1,16}|asset:[0-9a-f]{40})?$")


class UserBody(BaseModel):
    name: Optional[str] = None
    avatar: Optional[str] = None


class JobRequest(BaseModel):
    board: Optional[str] = None
    node: Optional[str] = None
    model: str                      # model family key, e.g. gemini-3.1-flash-image
    ratio: str = "16:9"
    size: str = "1K"
    prompt: str = Field(min_length=1, max_length=20000)
    refs: list[str] = Field(default_factory=list, max_length=14)
    count: int = Field(default=1, ge=1, le=8)


class UpscaleBody(BaseModel):
    asset: str = Field(pattern=r"^[0-9a-f]{40}$")
    board: Optional[str] = None


class BoardBody(BaseModel):
    name: Optional[str] = Field(default=None, max_length=80)
    data: Optional[dict] = None


def resolve_size(settings: Settings, supported: list[str], size: str) -> Optional[tuple[str, Optional[int]]]:
    """Where a resolution comes from: (size Flow generates, long edge to enlarge to with ComfyUI or None), or None if
    this resolution is switched off / impossible for the model."""
    size = (size or "1K").upper()
    spec = settings.resolutions.get(size) or ({"route": "flow"} if size in supported else {"route": "off"})
    if size in settings.disabled_sizes or spec.get("route") == "off":
        return None
    if spec.get("route") == "comfy":
        base = str(spec.get("base") or "2K").upper()
        if not settings.comfy_url:
            return None
        if base not in supported:
            base = supported[0] if supported else ""
        return (base, int(spec.get("target") or 4096)) if base else None
    return (size, None) if size in supported else None


def upscale_info(settings: Settings) -> dict:
    """What the "enlarge" button on the canvas does (the 4K entry when it is a ComfyUI one, else a 4096 px default)."""
    spec = settings.resolutions.get("4K") or {}
    target = int(spec.get("target") or 4096) if spec.get("route") == "comfy" else 4096
    return {"enabled": bool(settings.comfy_url), "label": f"{round(target / 1024)}K", "target": target}


def allowed_catalog(settings: Settings, catalog: list[dict]) -> list[dict]:
    """Drop the models and resolutions the admin switched off in config.json; add the ComfyUI-enlarged ones."""
    out = []
    for m in catalog:
        if m["key"] in settings.disabled_models:
            continue
        sizes = [z for z in SIZE_ORDER if resolve_size(settings, m["sizes"], z)]
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
        """The X-User header carries the user's uuid; a plain name still works for clients from before ids existed."""
        from urllib.parse import unquote
        value = unquote((x_user or "").strip())
        if ID_RE.match(value) and store.get_user(value):
            return value
        found = store.get_user_by_name(value) if value else None
        if not found:
            raise HTTPException(401, "请先选择用户")
        return found["id"]

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
            return {"models": allowed_catalog(settings, catalog), "max_count": settings.max_count,
                    "upscale": upscale_info(settings)}
        except (FlowError, httpx.HTTPError) as exc:
            raise HTTPException(502, f"无法读取模型列表：{exc}")

    @app.get("/api/usage")
    async def usage(user: str = user_dep):
        try:
            data = await flow.usage()
        except (FlowError, httpx.HTTPError) as exc:
            raise HTTPException(502, f"无法读取额度：{exc}")
        # one shared Flow account for now; per-user allowances can be added here later
        return {"credits": data.get("credits"), "image_daily": data.get("image_daily") or [], "date": data.get("date"),
                "scope": "total"}

    # ---- boards
    @app.get("/api/users")
    async def list_users():
        # LAN tool: the login page offers the existing users (id, name, avatar)
        return {"users": store.list_users()}

    @app.post("/api/users")
    async def create_user(body: UserBody):
        name = (body.name or "").strip()
        if not USER_RE.match(name):
            raise HTTPException(400, "名字需要 1–32 个字符")
        try:
            return store.create_user(name)
        except sqlite3.IntegrityError:
            raise HTTPException(409, "这个名字已经有人用了")

    @app.get("/api/me")
    async def me(user: str = user_dep):
        return store.get_user(user)

    @app.put("/api/me")
    async def update_me(body: UserBody, user: str = user_dep):
        name = body.name.strip() if body.name is not None else None
        if name is not None and not USER_RE.match(name):
            raise HTTPException(400, "名字需要 1–32 个字符")
        if body.avatar is not None:
            if not AVATAR_RE.match(body.avatar):
                raise HTTPException(400, "头像格式不正确")
            if body.avatar.startswith("asset:") and not store.get_asset(body.avatar[6:]):
                raise HTTPException(400, "头像图片不存在")
        try:
            store.update_user(user, name=name, avatar=body.avatar)
        except sqlite3.IntegrityError:
            raise HTTPException(409, "这个名字已经有人用了")
        return store.get_user(user)

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

    def _import_full(zf: zipfile.ZipFile, name: str, user: str) -> dict:
        """Restore a board exported by the zip download: board.json (nodes, edges, viewport, name) + assets/*."""
        try:
            doc = json.loads(zf.read("board.json").decode("utf-8"))
            data = doc["data"]
            assert isinstance(data, dict)
        except Exception:
            raise HTTPException(400, "board.json 无法读取")
        exts = (".png", ".jpg", ".jpeg", ".webp", ".gif")
        entries = [i for i in zf.infolist() if not i.is_dir() and i.filename.lower().endswith(exts)]
        if len(entries) > 1000:
            raise HTTPException(400, "zip 里的图片太多")
        for i in entries:
            if i.file_size > settings.max_upload_bytes:
                continue
            try:
                save_image_bytes(settings, store, zf.read(i))
            except AssetError:
                continue
        nodes = []
        for n in data.get("nodes") or []:
            d = n.get("data") or {}
            if n.get("type") == "image":
                if d.get("pending") or not d.get("assetId") or not store.get_asset(d["assetId"]):
                    continue  # unfinished placeholders and images that did not come along
            elif n.get("type") == "gen":
                n["data"] = {**d, "jobs": []}  # jobs belong to the old board; finished results are already nodes
            elif n.get("type") == "refset":
                n["data"] = {**d, "slots": [s if (not s.get("assetId") or store.get_asset(s["assetId"])) else {"id": s.get("id")}
                                           for s in d.get("slots", [])]}
            nodes.append(n)
        keep = {n.get("id") for n in nodes}
        edges = [e for e in data.get("edges") or [] if e.get("source") in keep and e.get("target") in keep]
        title = ((doc.get("name") or name or "导入的画板").strip()[:60]) or "导入的画板"
        board = store.create_board(user, uuid.uuid4().hex[:12], title)
        store.save_board(user, board["id"], {"nodes": nodes, "edges": edges,
                                             "viewport": data.get("viewport") or {"x": 40, "y": 40, "zoom": 0.6}}, title)
        return {**board, "images": len(entries)}

    @app.post("/api/boards/import")
    async def import_board(request: Request, name: str = "", user: str = user_dep):
        """Create a board from a zip of images (the inverse of the zip download); images are laid out in a grid."""
        raw = await request.body()
        try:
            zf = zipfile.ZipFile(io.BytesIO(raw))
        except zipfile.BadZipFile:
            raise HTTPException(400, "不是有效的 zip 文件")
        if "board.json" in zf.namelist():
            return _import_full(zf, name, user)
        exts = (".png", ".jpg", ".jpeg", ".webp", ".gif")
        entries = sorted((i for i in zf.infolist() if not i.is_dir() and i.filename.lower().endswith(exts)),
                         key=lambda i: i.filename)
        if not entries:
            raise HTTPException(400, "zip 里没有图片")
        if len(entries) > 300:
            raise HTTPException(400, "zip 里的图片太多（最多 300 张）")
        nodes, seen = [], set()
        cols, cell_w = 4, 300
        for i in entries:
            if i.file_size > settings.max_upload_bytes:
                continue
            try:
                info = save_image_bytes(settings, store, zf.read(i))
            except AssetError:
                continue
            if info["id"] in seen:
                continue
            seen.add(info["id"])
            k = len(nodes)
            w = 260
            h = max(60, round(w * info["h"] / max(1, info["w"])))
            nodes.append({"id": f"img_{uuid.uuid4().hex[:8]}", "type": "image",
                          "position": {"x": (k % cols) * cell_w, "y": (k // cols) * 340},
                          "width": w, "height": h, "data": {"assetId": info["id"], "w": info["w"], "h": info["h"]}})
        if not nodes:
            raise HTTPException(400, "zip 里没有可用的图片")
        title = (name or "导入的画板").strip()[:60] or "导入的画板"
        board = store.create_board(user, uuid.uuid4().hex[:12], title)
        store.save_board(user, board["id"], {"nodes": nodes, "edges": [], "viewport": {"x": 40, "y": 40, "zoom": 0.6}}, title)
        return {**board, "images": len(nodes)}

    @app.get("/api/boards/{board_id}/zip")
    async def board_zip(board_id: str, user: str = user_dep):
        """The whole board as a zip: board.json (nodes, edges, viewport, name) and every image under assets/."""
        board = store.get_board(user, board_id)
        if not board:
            raise HTTPException(404, "画板不存在")
        ids: list[str] = []
        for n in (board["data"].get("nodes") or []):
            d = n.get("data") or {}
            found = [d.get("assetId")] if n.get("type") == "image" else (
                [s.get("assetId") for s in d.get("slots", [])] if n.get("type") == "refset" else [])
            for a in found:
                if a and a not in ids:
                    ids.append(a)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:  # images are already compressed
            doc = {"format": "flow-canvas-board", "version": 1, "name": board["name"], "data": board["data"]}
            zf.writestr("board.json", json.dumps(doc, ensure_ascii=False, indent=1))
            for a in ids:
                meta = store.get_asset(a) if re.fullmatch(r"[0-9a-f]{40}", a) else None
                path = asset_path(settings, a) if meta else None
                if not meta or not path or not path.exists():
                    continue
                ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}.get(meta["mime"], "img")
                zf.write(path, f"assets/{a}.{ext}")
        fname = quote(re.sub(r'[\\/:*?"<>|]', "_", board["name"] or "board") + ".zip")
        return Response(buf.getvalue(), media_type="application/zip",
                        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{fname}"})

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
        if body.count > settings.max_count:
            raise HTTPException(400, f"一次最多生成 {settings.max_count} 张")
        try:
            catalog = await flow.models()
        except (FlowError, httpx.HTTPError):
            catalog = []
        fam = next((m for m in catalog if m["key"] == body.model), None)
        route = resolve_size(settings, fam["sizes"] if fam else ["1K"], body.size)
        if not route:
            raise HTTPException(400, f"{body.size} 分辨率已被管理员关闭或暂不可用")
        flow_size, upscale_to = route
        try:
            mid = model_id(body.model, body.ratio, flow_size)
        except FlowError as exc:
            raise HTTPException(400, str(exc))
        for asset_id in body.refs:
            if not store.get_asset(asset_id):
                raise HTTPException(400, "参考图不存在，请重新添加")
        ids = runner.submit(user=user, board=body.board, node=body.node, model=mid,
                            prompt=body.prompt.strip(), refs=body.refs, count=body.count,
                            extra={"upscale_to": upscale_to, "size": body.size.upper()} if upscale_to else None)
        return {"jobs": ids}

    @app.post("/api/upscale")
    async def upscale(body: UpscaleBody, user: str = user_dep):
        info = upscale_info(settings)
        if not info["enabled"]:
            raise HTTPException(400, "服务器没有配置放大功能")
        if not store.get_asset(body.asset):
            raise HTTPException(400, "图片不存在")
        ids = runner.submit(user=user, board=body.board, node=None, model="comfy:upscale", prompt="", refs=[body.asset],
                            extra={"standalone": True, "upscale_to": info["target"]})
        return {"jobs": ids, "label": info["label"]}

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
