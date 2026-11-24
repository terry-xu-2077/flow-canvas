"""Board export / import as a zip: board.json (nodes, edges, viewport, name) plus the pictures and videos under assets/."""
from __future__ import annotations

import io
import json
import re
import uuid
import zipfile
from pathlib import Path

from .assets import AssetError, asset_path, save_image_bytes, save_video_bytes
from .config import Settings
from .db import Store

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
VIDEO_EXTS = (".mp4", ".webm", ".mov")
MIME_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
            "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov"}
DEFAULT_VIEWPORT = {"x": 40, "y": 40, "zoom": 0.6}


class ImportError_(ValueError):
    """The zip cannot be imported; the message is shown to the user."""


def _title(*candidates: str) -> str:
    for c in candidates:
        c = (c or "").strip()[:60]
        if c:
            return c
    return "导入的画板"


def import_full(settings: Settings, store: Store, zf: zipfile.ZipFile, name: str, user: str) -> dict:
    """Restore a board exported by the zip download."""
    try:
        if zf.getinfo("board.json").file_size > 100 * 1024 ** 2:
            raise ValueError("too big")
        doc = json.loads(zf.read("board.json").decode("utf-8"))
        data = doc["data"]
        assert isinstance(data, dict)
    except Exception:
        raise ImportError_("board.json 无法读取")
    entries = [i for i in zf.infolist() if not i.is_dir() and i.filename.lower().endswith(IMAGE_EXTS)]
    if len(entries) > 1000:
        raise ImportError_("zip 里的图片太多")
    for i in entries:
        if i.file_size > settings.max_upload_bytes:
            continue
        try:
            save_image_bytes(settings, store, zf.read(i))
        except AssetError:
            continue
    for i in zf.infolist():   # generated videos that came along
        ext = Path(i.filename).suffix.lower()
        if not i.is_dir() and ext in VIDEO_EXTS and i.filename.startswith("assets/"):
            save_video_bytes(settings, store, zf.read(i), ext)
    nodes = []
    for n in data.get("nodes") or []:
        d = n.get("data") or {}
        if n.get("type") in ("image", "video"):
            if d.get("pending") or not d.get("assetId") or not store.get_asset(d["assetId"]):
                continue  # unfinished placeholders and media that did not come along
        elif n.get("type") in ("gen", "vgen"):
            n["data"] = {**d, "jobs": []}  # jobs belong to the old board; finished results are already nodes
        elif n.get("type") == "refset":
            n["data"] = {**d, "slots": [s if (not s.get("assetId") or store.get_asset(s["assetId"])) else {"id": s.get("id")}
                                       for s in d.get("slots", [])]}
        nodes.append(n)
    keep = {n.get("id") for n in nodes}
    edges = [e for e in data.get("edges") or [] if e.get("source") in keep and e.get("target") in keep]
    title = _title(doc.get("name"), name)
    board = store.create_board(user, uuid.uuid4().hex[:12], title)
    store.save_board(user, board["id"], {"nodes": nodes, "edges": edges,
                                         "viewport": data.get("viewport") or DEFAULT_VIEWPORT}, title)
    return {**board, "images": len(entries)}


def import_images(settings: Settings, store: Store, zf: zipfile.ZipFile, name: str, user: str) -> dict:
    """A plain zip of pictures becomes a new board with the pictures laid out in a grid."""
    entries = sorted((i for i in zf.infolist() if not i.is_dir() and i.filename.lower().endswith(IMAGE_EXTS)),
                     key=lambda i: i.filename)
    if not entries:
        raise ImportError_("zip 里没有图片")
    if len(entries) > 300:
        raise ImportError_("zip 里的图片太多（最多 300 张）")
    nodes, seen = [], set()
    cols, cell_w, w = 4, 300, 260
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
        h = max(60, round(w * info["h"] / max(1, info["w"])))
        nodes.append({"id": f"img_{uuid.uuid4().hex[:8]}", "type": "image",
                      "position": {"x": (k % cols) * cell_w, "y": (k // cols) * 340},
                      "width": w, "height": h, "data": {"assetId": info["id"], "w": info["w"], "h": info["h"]}})
    if not nodes:
        raise ImportError_("zip 里没有可用的图片")
    title = _title(name)
    board = store.create_board(user, uuid.uuid4().hex[:12], title)
    store.save_board(user, board["id"], {"nodes": nodes, "edges": [], "viewport": DEFAULT_VIEWPORT}, title)
    return {**board, "images": len(nodes)}


def import_zip(settings: Settings, store: Store, raw: bytes, name: str, user: str) -> dict:
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise ImportError_("不是有效的 zip 文件")
    if "board.json" in zf.namelist():
        return import_full(settings, store, zf, name, user)
    return import_images(settings, store, zf, name, user)


def export_zip(settings: Settings, store: Store, board: dict) -> bytes:
    """The whole board as a zip: board.json and every picture / video under assets/."""
    ids: list[str] = []
    for n in (board["data"].get("nodes") or []):
        d = n.get("data") or {}
        found = [d.get("assetId")] if n.get("type") in ("image", "video") else (
            [s.get("assetId") for s in d.get("slots", [])] if n.get("type") == "refset" else [])
        if isinstance(d.get("markup"), dict):  # the untouched picture under an annotated card travels with it
            found.append(d["markup"].get("base"))
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
            zf.write(path, f"assets/{a}.{MIME_EXT.get(meta['mime'], 'img')}")
    return buf.getvalue()
