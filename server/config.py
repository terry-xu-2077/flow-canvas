"""Runtime configuration (config.json next to the project, overridable by env vars)."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SIZE_ORDER = ("1K", "2K", "4K", "6K")


# Long edge each resolution stands for (16:9; Flow's own 1K / 2K are 1376 / 2752 px wide).
SIZE_TARGET = {"1K": 1376, "2K": 2752, "4K": 4096, "6K": 6144}


def default_resolutions() -> dict:
    # route: flow = Flow makes it directly; comfy = Flow makes the largest smaller size, then ComfyUI enlarges it with
    # `engine` (seedvr2 | pid); off = hidden. The base size and the target pixels are worked out by the server.
    return {
        "1K": {"route": "flow"},
        "2K": {"route": "flow"},
        "4K": {"route": "comfy", "engine": "seedvr2"},
        "6K": {"route": "comfy", "engine": "seedvr2"},
    }


@dataclass
class Settings:
    # The aggregation API (terry2api) is the only place generation goes: Flow, ChatGPT, 小云雀, LibTV and Lovart all sit behind it.
    gateway_url: str = ""
    gateway_key: str = ""
    gateway_timeout: float = 1800.0   # longest a generation (a video, say) may run, in seconds
    host: str = "0.0.0.0"
    port: int = 8870
    data_dir: Path = ROOT / "data"
    max_upload_bytes: int = 30 * 1024 * 1024
    # Flow-only canvas behaviour: Flow models switched off for everyone (model family keys), resolutions switched off
    disabled_sizes: tuple = ()    # e.g. "4K"
    max_count: int = 4            # most images one card may ask for at once
    # How many Flow images one user may have generating at the same time (across all their cards); the rest wait in line.
    user_concurrency: int = 4
    # Local ComfyUI used for enlarging (and later other jobs). Empty url = not configured.
    comfy_url: str = ""
    comfy_engine: str = "seedvr2"     # which enlarge workflow: seedvr2 | pid
    comfy_seedvr2: dict = field(default_factory=dict)
    comfy_pid: dict = field(default_factory=dict)
    comfy_timeout: float = 1800.0
    resolutions: dict = field(default_factory=default_resolutions)

    @property
    def assets_dir(self) -> Path:
        return self.data_dir / "assets"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "canvas.db"


def load_settings(path: Path | None = None) -> Settings:
    cfg_path = path or Path(os.environ.get("FLOW_CANVAS_CONFIG", ROOT / "config.json"))
    raw: dict = {}
    if cfg_path.exists():
        raw = json.loads(cfg_path.read_text(encoding="utf-8"))
    s = Settings()
    # older config files called the aggregation API "cloud_*"
    for key, old in (("gateway_url", "cloud_base_url"), ("gateway_key", "cloud_api_key")):
        v = raw.get(key) or raw.get(old)
        if v:
            setattr(s, key, str(v).strip())
    if raw.get("host"):
        s.host = str(raw["host"]).strip()
    for key, old, cast in (("port", None, int), ("gateway_timeout", "cloud_timeout", float),
                           ("max_upload_bytes", None, int)):
        v = raw.get(key) if raw.get(key) is not None else (raw.get(old) if old else None)
        if v is not None:
            setattr(s, key, cast(v))
    s.disabled_sizes = tuple(str(x).strip().upper() for x in (raw.get("disabled_sizes") or []) if str(x).strip())
    if raw.get("user_concurrency") is not None:
        s.user_concurrency = max(1, min(64, int(raw["user_concurrency"])))
    cf = raw.get("comfyui") or {}
    if str(cf.get("url") or "").strip():
        s.comfy_url = str(cf["url"]).strip().rstrip("/")
    if cf.get("upscale_engine"):
        s.comfy_engine = str(cf["upscale_engine"]).strip()
    s.comfy_seedvr2 = dict(cf.get("seedvr2") or {})
    s.comfy_pid = dict(cf.get("pid") or {})
    if cf.get("timeout") is not None:
        s.comfy_timeout = float(cf["timeout"])
    for size, spec in (raw.get("resolutions") or {}).items():
        if str(size).upper() in SIZE_ORDER and isinstance(spec, dict):
            s.resolutions[str(size).upper()] = {**s.resolutions.get(str(size).upper(), {}), **spec}
    if raw.get("data_dir"):
        d = Path(raw["data_dir"])
        s.data_dir = d if d.is_absolute() else ROOT / d
    s.gateway_url = s.gateway_url.rstrip("/")
    return s
