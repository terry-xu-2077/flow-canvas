"""FastAPI app: boards, assets, jobs, models; also serves the built web UI."""
from __future__ import annotations

import io
import json
import re
import sqlite3
import asyncio
import time
import uuid
import zipfile
from urllib.parse import quote
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .assets import AssetError, asset_path, save_image_bytes, save_video_bytes, thumbnail_path
from .config import SIZE_ORDER, SIZE_TARGET, ROOT, Settings, load_settings
from .db import Store
from .errors import GenError
from .gateway import GatewayClient
from .jobs import JobRunner, job_percent

PICTURE_TAG_RE = re.compile(r"<Picture\s+(\d+)>", re.I)

USER_RE = re.compile(r"^[\w一-鿿\- ]{1,32}$")
ID_RE = re.compile(r"^[0-9a-f]{32}$")
AVATAR_RE = re.compile(r"^(emoji:.{1,16}|asset:[0-9a-f]{40})?$")


class UserBody(BaseModel):
    name: Optional[str] = None
    avatar: Optional[str] = None


class JobRequest(BaseModel):
    board: Optional[str] = None
    node: Optional[str] = None
    model: str                      # the aggregation API's model id, e.g. flow:Nano Banana 2.1 (a card saved earlier may still hold the old key)
    ratio: str = "16:9"
    size: str = "1K"
    prompt: str = Field(min_length=1, max_length=20000)
    refs: list[str] = Field(default_factory=list, max_length=14)
    count: int = Field(default=1, ge=1, le=8)
    quality: str = ""               # quality tier of the models that have one (low / medium / high ...); empty = the platform's default


class VideoJobRequest(BaseModel):
    board: Optional[str] = None
    node: Optional[str] = None
    model: str                      # "provider:name", the id terry2api lists (e.g. xyq:Seedance 2.0)
    prompt: str = Field(default="", max_length=20000)
    ratio: str = ""
    resolution: str = ""
    duration: int = Field(default=0, ge=0, le=300)
    sound: bool = True
    mode: str = "auto"              # auto: 0 pictures = text, 1 = first frame, 2 = first + last frame, more = references; reference: all are references
    refs: list[str] = Field(default_factory=list, max_length=9)
    count: int = Field(default=1, ge=1, le=4)


class UpscaleBody(BaseModel):
    asset: str = Field(pattern=r"^[0-9a-f]{40}$")
    board: Optional[str] = None
    size: Optional[str] = None      # which resolution to enlarge to (4K / 6K ...); default the first one offered


class BoardBody(BaseModel):
    name: Optional[str] = Field(default=None, max_length=80)
    data: Optional[dict] = None


def resolve_size(settings: Settings, supported: list[str], size: str) -> Optional[tuple[str, Optional[int], str]]:
    """Where a resolution comes from: (size Flow generates, long edge to enlarge to with ComfyUI or None, enlarge
    engine), or None when this resolution is switched off / impossible for the model."""
    size = (size or "1K").upper()
    spec = settings.resolutions.get(size) or ({"route": "flow"} if size in supported else {"route": "off"})
    if size in settings.disabled_sizes or spec.get("route") == "off":
        return None
    if spec.get("route") == "comfy":
        if not settings.comfy_url or not supported:
            return None
        target = int(spec.get("target") or SIZE_TARGET.get(size, 4096))
        base = str(spec.get("base") or "").upper()
        if base not in supported:
            # only a size Flow itself makes (its 2K stage already enlarges once, so a 2K that ComfyUI takes over is no base) and never native 4K
            smaller = [z for z in ("1K", "2K") if z in supported and SIZE_TARGET[z] < target
                       and (settings.resolutions.get(z) or {"route": "flow"}).get("route", "flow") == "flow"]
            base = smaller[-1] if smaller else supported[0]
        return base, target, str(spec.get("engine") or settings.comfy_engine)
    return (size, None, "") if size in supported else None


def upscale_options(settings: Settings) -> list[dict]:
    """The enlarge steps the canvas button can offer: every resolution whose source is a ComfyUI enlarge."""
    if not settings.comfy_url:
        return []
    out = []
    for size in SIZE_ORDER:
        spec = settings.resolutions.get(size) or {}
        if spec.get("route") == "comfy" and size not in settings.disabled_sizes:
            out.append({"size": size, "target": int(spec.get("target") or SIZE_TARGET[size]),
                        "engine": str(spec.get("engine") or settings.comfy_engine)})
    return out or [{"size": "4K", "target": SIZE_TARGET["4K"], "engine": settings.comfy_engine}]


def upscale_info(settings: Settings) -> dict:
    return {"enabled": bool(settings.comfy_url), "options": upscale_options(settings)}


CLOUD_PROVIDERS = ("xyq", "libtv", "lovart")      # sources that make video too (and whose credits the top bar shows)
SOURCE_NAMES = {"flow": "Flow", "chatgpt": "ChatGPT", "xyq": "小云雀", "libtv": "LibTV", "lovart": "Lovart"}
DEFAULT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"]
REF_LIMITS = {"flow": 14, "chatgpt": 8}   # most reference pictures a source takes (the rest take 9)


def mentions_to_ordinals(prompt: str, n_refs: int) -> str:
    """<Picture N> -> "第N张图"; a tag outside the list is dropped."""
    return PICTURE_TAG_RE.sub(lambda m: f"第{m.group(1)}张图" if 1 <= int(m.group(1)) <= n_refs else "", prompt)


FREE_PROVIDERS = ("flow", "chatgpt")   # no credits are spent on these (Flow: the shared flow2api account; ChatGPT: its own quota)


def combo_is_free(m: dict, size: str, quality: str = "") -> bool:
    """May a user without credit-model access pick this size + quality on this gateway model?
    Free = 0 credits: the model is a free source, or the price table says 0 (zero), or the unlimited-slow mode covers it (slow; a
    condition beyond the size, e.g. "low" quality, has to be matched by the chosen quality)."""
    if m.get("provider") in FREE_PROVIDERS:
        return True
    free, s, q = m.get("free") or {}, str(size).lower(), (quality or "").lower()
    zero = free.get("zero") or []
    if q == "" and any(z == "*" or str(z).lower() == s for z in zero):
        return True
    slow = free.get("slow")
    if slow and any(z == "*" or str(z).lower() == s for z in slow.get("res") or []):
        extra = [str(x).lower() for x in slow.get("extra") or []]
        return all(x == q for x in extra) if extra else q == ""
    return False


def create_app(settings: Optional[Settings] = None, gateway: Optional[GatewayClient] = None) -> FastAPI:
    settings = settings or load_settings()
    store = Store(settings.db_path)
    settings.assets_dir.mkdir(parents=True, exist_ok=True)
    gateway = gateway or GatewayClient(settings.gateway_url, settings.gateway_key)
    runner = JobRunner(settings, store, gateway)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        store.fail_unfinished_jobs("服务重启，任务已中断")
        yield
        await runner.shutdown()
        await gateway.close()

    app = FastAPI(title="Flow Canvas", lifespan=lifespan)
    app.state.settings, app.state.store, app.state.runner, app.state.gateway = settings, store, runner, gateway

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
            info["gateway"] = {p["id"]: p.get("usable") for p in (await gateway.providers()).get("providers", [])}
        except Exception as exc:
            info["gateway"] = {"error": f"{type(exc).__name__}"}
        return info

    usable_cache: dict = {"at": 0.0, "set": set()}

    quote_cache: dict = {}
    quote_locks: dict = {}
    QUOTE_TTL = 600

    async def usable_providers() -> set:
        """Sources that are switched on in the aggregation API and set up there (the rest never show on the canvas)."""
        if not gateway.enabled:
            return set()
        if time.time() - usable_cache["at"] < 20:
            return usable_cache["set"]
        try:
            data = await gateway.providers()
            usable_cache.update(at=time.time(), set={p["id"] for p in data.get("providers", []) if p.get("usable", p.get("configured"))})
        except GenError:
            usable_cache["at"] = time.time() - 10   # try again soon, keep the last answer meanwhile
        return usable_cache["set"]

    model_cache: dict = {"at": 0.0, "models": [], "task": None}

    async def _reload_models() -> None:
        try:
            data = await gateway.models("image")
            model_cache.update(at=time.time(), models=data.get("models", []))
        except GenError:
            model_cache["at"] = time.time() - 50      # keep the last good list, try again in ~10 s
        finally:
            model_cache["task"] = None

    async def raw_models() -> list[dict]:
        """Image models of every source the aggregation API offers (it lists only sources that are on and set up). The list is
        cached for a minute; once it is older, the last list is still served at once while a refresh runs in the background
        (a cold refresh can take ten seconds and must never hold up a click on 生成). Only the very first load waits."""
        fresh = time.time() - model_cache["at"] < 60
        if not fresh and model_cache["task"] is None:
            model_cache["task"] = asyncio.ensure_future(_reload_models())
        if not model_cache["models"]:
            task = model_cache["task"]
            if task is not None:
                await task
            if not model_cache["models"]:
                raise GenError("无法读取模型列表（聚合API没有返回任何模型）")
        return model_cache["models"]

    async def image_models() -> list[dict]:
        out = []
        for m in await raw_models():
            pid = m["provider"]
            caps = ((m.get("capabilities") or {}).get("params")) or {}
            info = m.get("info") or {}
            ratios = [r for r in (info.get("ratios") or (caps.get("ratio") or {}).get("enum") or [])
                      if ":" in str(r) and str(r).replace(":", "").replace(".", "").isdigit()] or DEFAULT_RATIOS
            declared = [str(r).upper() for r in (info.get("resolutions") or (caps.get("resolution") or {}).get("enum") or [])]
            raw_sizes = declared or (["1K", "2K", "4K"] if pid in CLOUD_PROVIDERS else ["1K"])
            sizes = raw_sizes
            if pid == "flow":
                sizes = [z for z in SIZE_ORDER if resolve_size(settings, raw_sizes, z)]
                if not sizes:
                    continue
            out.append({"key": m["id"], "legacy": m.get("key"), "name": m["name"], "ratios": ratios, "sizes": sizes, "provider": pid,
                        "tag": SOURCE_NAMES.get(pid, pid), "refs": True, "kind": "image", "free": m.get("free"),
                        "qualities": m.get("qualities") or [], "_raw_sizes": raw_sizes, "_gw": m})
        return out

    def for_user(models: list[dict], paid: bool) -> list[dict]:
        """What a user may see: everything for users with credit-model access, else only the free models, and of those only the free
        sizes / qualities (`combos` lists the allowed [size, quality] pairs so the card can keep them consistent)."""
        out = []
        for m in models:
            item = {k: v for k, v in m.items() if k not in ("_raw_sizes", "_gw")}
            if not paid:
                gw = m.get("_gw") or {}
                qs = [""] + list(m.get("qualities") or [])
                combos = [[z, q] for z in m["sizes"] for q in qs if combo_is_free(gw, z, q)]
                if not combos:
                    continue
                item["sizes"] = list(dict.fromkeys(c[0] for c in combos))
                item["qualities"] = [q for q in (m.get("qualities") or []) if any(c[1] == q for c in combos)]
                item["combos"] = combos if m["provider"] not in FREE_PROVIDERS else None
            out.append(item)
        return out

    @app.get("/api/models")
    async def models(refresh: bool = False, user: str = user_dep):
        if refresh:
            model_cache["at"] = 0.0
        paid = bool((store.get_user(user) or {}).get("paid"))
        try:
            listed = for_user(await image_models(), paid)
        except GenError as exc:
            raise HTTPException(502, f"无法读取模型列表：{exc}")
        return {"models": listed, "max_count": settings.max_count, "upscale": upscale_info(settings), "paid": paid}

    @app.get("/api/usage")
    async def usage(user: str = user_dep):
        try:
            items = {i["provider"]: i for i in (await gateway.credits(live=False)).get("items", [])}
        except GenError as exc:
            raise HTTPException(502, f"无法读取额度：{exc}")
        fl, gp = items.get("flow"), items.get("chatgpt")
        # one shared Flow account; the aggregation API reports its credits and today's counters
        return {"credits": (fl or {}).get("balance"), "image_daily": (fl or {}).get("image_daily") or [], "date": None,
                "scope": "total", "gpt": (gp or {}).get("quota")}

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
        for i in zf.infolist():   # generated videos that came along
            ext = Path(i.filename).suffix.lower()
            if not i.is_dir() and ext in (".mp4", ".webm", ".mov") and i.filename.startswith("assets/"):
                save_video_bytes(settings, store, zf.read(i), ext)
        nodes = []
        for n in data.get("nodes") or []:
            d = n.get("data") or {}
            if n.get("type") == "image":
                if d.get("pending") or not d.get("assetId") or not store.get_asset(d["assetId"]):
                    continue  # unfinished placeholders and images that did not come along
            elif n.get("type") == "video":
                if d.get("pending") or not d.get("assetId") or not store.get_asset(d["assetId"]):
                    continue
            elif n.get("type") in ("gen", "vgen"):
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
            found = [d.get("assetId")] if n.get("type") in ("image", "video") else (
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
                ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
                       "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov"}.get(meta["mime"], "img")
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

    @app.get("/api/library")
    async def library(user: str = user_dep):
        return store.library(user)

    @app.get("/api/assets/{asset_id}")
    async def get_asset(asset_id: str, w: Optional[int] = None, download: bool = False):
        meta = store.get_asset(asset_id) if re.fullmatch(r"[0-9a-f]{40}", asset_id) else None
        path = asset_path(settings, asset_id) if meta else None
        if not meta or not path or not path.exists():
            raise HTTPException(404, "图片不存在")
        headers = {"Cache-Control": "public, max-age=31536000, immutable"}
        if download:
            ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
                   "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov"}.get(meta["mime"], "img")
            headers["Content-Disposition"] = f'attachment; filename="{asset_id[:12]}.{ext}"'
            return FileResponse(path, media_type=meta["mime"], headers=headers)
        if w and meta["mime"].startswith("image/"):
            thumb = thumbnail_path(settings, asset_id, w)
            mime = meta["mime"] if thumb == path else "image/webp"
            return FileResponse(thumb, media_type=mime, headers=headers)
        return FileResponse(path, media_type=meta["mime"], headers=headers)

    # ---- jobs
    @app.post("/api/jobs")
    async def create_jobs(body: JobRequest, user: str = user_dep):
        if body.count > settings.max_count:
            raise HTTPException(400, f"一次最多生成 {settings.max_count} 张")
        try:
            listed = await raw_models()
        except GenError as exc:
            raise HTTPException(502, f"无法连接聚合API：{exc}")
        if ":" not in body.model:   # a card saved before the aggregation API still names the old key (gemini-… / gpt-image)
            hit = next((m for m in listed if m.get("key") == body.model or (body.model == "gpt-image" and m.get("provider") == "chatgpt")), None)
            if hit:
                body.model = hit["id"]
        provider, _, name = body.model.partition(":")
        if not name or not any(m["id"] == body.model for m in listed):
            raise HTTPException(400, "这个模型所在的平台没有启用，或还没有在聚合API里授权")
        if not (store.get_user(user) or {}).get("paid"):
            gw = next((m["_gw"] for m in await image_models() if m["key"] == body.model), None) or next(m for m in listed if m["id"] == body.model)
            if not combo_is_free(gw, body.size, body.quality):
                raise HTTPException(403, "这个模型 / 选项会消耗积分，需要管理员在控制台给你开通「积分模型」")
        limit = REF_LIMITS.get(provider, 9)
        if len(body.refs) > limit:
            raise HTTPException(400, f"最多带 {limit} 张参考图")
        for rid in body.refs:
            if not store.get_asset(rid):
                raise HTTPException(400, "参考图已不存在，请重新添加")
        resolution, extra_up = body.size, {}
        if provider == "flow":   # Flow's own 1K / 2K, or a smaller size that ComfyUI then enlarges (4K / 6K)
            shown = next((m for m in await image_models() if m["key"] == body.model), None)
            if shown is None:
                raise HTTPException(400, "该模型已被管理员关闭")
            route = resolve_size(settings, shown["_raw_sizes"], body.size)
            if not route:
                raise HTTPException(400, f"{body.size} 分辨率已被管理员关闭或暂不可用")
            resolution, upscale_to, engine = route
            if upscale_to:
                extra_up = {"upscale_to": upscale_to, "engine": engine, "size": body.size.upper()}
        ids = runner.submit(user=user, board=body.board, node=body.node, model=f"cloud:{body.model}",
                            prompt=body.prompt.strip(), refs=body.refs, count=body.count,
                            extra={"cloud": {"kind": "image", "provider": provider, "model": name, "ratio": body.ratio,
                                             "resolution": resolution, "quality": body.quality, "refs": body.refs}, **extra_up})
        return {"jobs": ids}

    @app.post("/api/upscale")
    async def upscale(body: UpscaleBody, user: str = user_dep):
        options = upscale_options(settings)
        if not options:
            raise HTTPException(400, "服务器没有配置放大功能")
        asset = store.get_asset(body.asset)
        if not asset:
            raise HTTPException(400, "图片不存在")
        # the asked size when it really is bigger than the picture, otherwise the next step above it
        long_edge = max(asset.get("w") or 0, asset.get("h") or 0)
        bigger = [o for o in options if o["target"] > long_edge * 1.02]
        if not bigger:
            raise HTTPException(400, f"这张图已经有 {long_edge} 像素，没有更大的放大档位了")
        opt = next((o for o in bigger if o["size"] == (body.size or "").upper()), bigger[0])
        ids = runner.submit(user=user, board=body.board, node=None, model="comfy:upscale", prompt="", refs=[body.asset],
                            extra={"standalone": True, "upscale_to": opt["target"], "engine": opt["engine"], "size": opt["size"]})
        return {"jobs": ids, "label": opt["size"]}

    @app.get("/api/jobs")
    async def get_jobs(ids: str, user: str = user_dep):
        wanted = [i for i in ids.split(",") if re.fullmatch(r"[0-9a-f]{16}", i)][:64]
        rows = [j for j in store.get_jobs(wanted) if j["user"] == user]
        out = []
        for j in rows:
            item = {k: j[k] for k in ("id", "node", "status", "progress", "error", "result_asset", "model")}
            item["kind"] = (j["extra"].get("cloud") or {}).get("kind", "video") if j["extra"].get("cloud") else "image"
            cloud = j["extra"].get("cloud") or {}   # who made it: shown at the bottom-left of the result card
            item["label"] = f"{SOURCE_NAMES.get(cloud.get('provider'), cloud.get('provider'))} · {cloud.get('model')}" if cloud.get("provider") and cloud.get("model") else ""
            pct = job_percent(j, time.time())
            if pct > 0:
                item["progress"] = f"{pct}%"
            asset = store.get_asset(j["result_asset"]) if j["result_asset"] else None
            item["result_w"], item["result_h"] = (asset["w"], asset["h"]) if asset else (None, None)
            out.append(item)
        return {"jobs": out}

    # ---- video generation through terry2api (小云雀 / LibTV / Lovart)
    @app.get("/api/video/models")
    async def video_models(user: str = user_dep):
        if not gateway.enabled:
            return {"enabled": False, "models": [], "errors": {}}
        paid = bool((store.get_user(user) or {}).get("paid"))
        try:
            data = await gateway.models("video")
        except GenError as exc:
            raise HTTPException(502, f"无法读取视频模型：{exc}")
        active = {p for p in await usable_providers() if p in CLOUD_PROVIDERS}
        models = [{"key": m["id"], "name": m["name"], "provider": m["provider"], "tag": SOURCE_NAMES.get(m["provider"], m["provider"]),
                   "vip": bool(m.get("vip")), "info": m.get("info"), "free": m.get("free")} for m in data.get("models", []) if m.get("provider") in active]
        if not paid:   # video models cost credits (a model stays only when the price table says every setting is free)
            models = [m for m in models if (m.get("free") or {}).get("zero") == ["*"]]
        return {"enabled": True, "models": models, "errors": data.get("errors") or {}, "locked": not paid}

    @app.get("/api/video/model_info")
    async def video_model_info(model: str, kind: str = "video"):
        provider, _, name = model.partition(":")
        if not gateway.enabled or not name:
            raise HTTPException(400, "模型不对")
        try:
            return await gateway.model_info(provider, "image" if kind == "image" else "video", name)
        except GenError as exc:
            raise HTTPException(502, str(exc))

    @app.get("/api/video/quote")
    async def video_quote(model: str, resolution: str = "", duration: int = 0, sound: bool = True, ratio: str = "",
                          refer_image: bool = False, kind: str = "video", quality: str = ""):
        """Estimated credits of one video with these settings (needs terry2api and its browser extension)."""
        provider, _, name = model.partition(":")
        if not name or provider not in await usable_providers():
            raise HTTPException(400, "模型不对，或这个平台没有启用")
        params = {"platform": provider, "kind": "image" if kind == "image" else "video", "model": name, "resolution": resolution,
                  "duration": duration, "sound": sound, "ratio": ratio, "refer_image": refer_image, "quality": quality}
        key = tuple(sorted(params.items()))
        hit = quote_cache.get(key)
        if hit and time.time() - hit[0] < QUOTE_TTL:
            return hit[1]                    # the same settings cost the same: no need to ask the platform again
        async with quote_locks.setdefault(key, asyncio.Lock()):      # many nodes asking the same thing at once share one query
            hit = quote_cache.get(key)
            if hit and time.time() - hit[0] < QUOTE_TTL:
                return hit[1]
            try:
                res = await gateway.quote(params)
            except GenError as exc:
                raise HTTPException(502, str(exc))
            quote_cache[key] = (time.time(), res)
            return res

    @app.get("/api/video/balances")
    async def video_balances():
        """Credits of the three platforms (terry2api: API where it can, the browser extension otherwise)."""
        if not gateway.enabled:
            return {"enabled": False, "items": []}
        try:
            data = await gateway.credits(live=False)
        except GenError as exc:
            raise HTTPException(502, str(exc))
        active = {p for p in await usable_providers() if p in CLOUD_PROVIDERS}
        items = [{"provider": i.get("provider"), "name": i.get("name"), "ok": bool(i.get("ok")), "balance": i.get("balance"),
                  "expire": i.get("expire") or "", "error": i.get("error") or "", "unlimited": i.get("unlimited") or [],
                  "detail": i.get("detail") or {}} for i in data.get("items", []) if i.get("provider") in active]
        return {"enabled": True, "items": items, "extension": bool((data.get("extension") or {}).get("connected"))}

    @app.post("/api/video/jobs")
    async def create_video_jobs(body: VideoJobRequest, user: str = user_dep):
        provider, _, name = body.model.partition(":")
        if provider not in CLOUD_PROVIDERS or not name:
            raise HTTPException(400, "视频模型不对")
        if provider not in await usable_providers():
            raise HTTPException(400, "这个平台没有启用，或还没有在聚合API里授权")
        if not (store.get_user(user) or {}).get("paid"):
            raise HTTPException(403, "视频生成会消耗积分，需要管理员在控制台给你开通「积分模型」")
        for rid in body.refs:
            if not store.get_asset(rid):
                raise HTTPException(400, "参考图已不存在，请重新添加")
        prompt = body.prompt.strip()
        refs = list(dict.fromkeys(body.refs))
        cloud_args: dict = {"provider": provider, "model": name, "ratio": body.ratio, "resolution": body.resolution,
                            "duration": body.duration, "sound": body.sound}
        if refs and body.mode != "reference" and len(refs) <= 2:
            cloud_args["first"] = refs[0]
            if len(refs) == 2:
                cloud_args["last"] = refs[1]
            prompt = mentions_to_ordinals(prompt, len(refs))   # the <Picture N> tags only make sense for reference pictures
        elif refs:
            cloud_args["refs"] = refs
        if not prompt and not cloud_args.get("first"):
            raise HTTPException(400, "请输入提示词，或连一张图作为首帧")
        ids = runner.submit(user=user, board=body.board, node=body.node, model=f"cloud:{body.model}",
                            prompt=prompt, refs=refs, count=body.count, extra={"cloud": cloud_args})
        return {"jobs": ids}

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
