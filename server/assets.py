"""Image asset storage (content-addressed files) and thumbnails."""
from __future__ import annotations

import hashlib
import io
from pathlib import Path

from PIL import Image, ImageOps

from .config import Settings
from .db import Store

ALLOWED_FORMATS = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp", "GIF": "image/gif"}


class AssetError(ValueError):
    pass


def asset_path(settings: Settings, asset_id: str) -> Path:
    return settings.assets_dir / asset_id


def save_image_bytes(settings: Settings, store: Store, data: bytes) -> dict:
    """Validate and store an image; identical bytes map to the same asset id."""
    if not data:
        raise AssetError("空文件")
    if len(data) > settings.max_upload_bytes:
        raise AssetError("图片太大")
    try:
        with Image.open(io.BytesIO(data)) as img:
            fmt = (img.format or "").upper()
            img.verify()
        with Image.open(io.BytesIO(data)) as img:
            w, h = img.size
    except Exception as exc:
        raise AssetError("不是有效的图片") from exc
    if fmt not in ALLOWED_FORMATS:
        raise AssetError(f"不支持的图片格式：{fmt or '未知'}")
    asset_id = hashlib.sha1(data).hexdigest()
    path = asset_path(settings, asset_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        tmp = path.with_suffix(".part")
        tmp.write_bytes(data)
        tmp.replace(path)
    store.put_asset(asset_id, ALLOWED_FORMATS[fmt], w, h, len(data))
    return {"id": asset_id, "w": w, "h": h, "mime": ALLOWED_FORMATS[fmt]}


def thumbnail_path(settings: Settings, asset_id: str, width: int) -> Path:
    """Return a cached WEBP thumbnail no wider than `width`, creating it on first use."""
    width = max(64, min(int(width), 2048))
    src = asset_path(settings, asset_id)
    if not src.exists():
        raise FileNotFoundError(asset_id)
    dst = settings.assets_dir / "thumbs" / f"{asset_id}_{width}.webp"
    if dst.exists():
        return dst
    dst.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as img:
        img = ImageOps.exif_transpose(img)
        if img.width <= width:
            return src
        img.thumbnail((width, width * 4))
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
        tmp = dst.with_suffix(".part")
        img.save(tmp, format="WEBP", quality=85)
        tmp.replace(dst)
    return dst
