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
    flow_base_url: str = "http://127.0.0.1:8866"
    flow_api_key: str = ""
    host: str = "0.0.0.0"
    port: int = 8870
    data_dir: Path = ROOT / "data"
    job_timeout: float = 900.0
    # How many jobs this service forwards to flow2api at once. flow2api has its own global
    # gate (image_max_concurrency) that queues the rest, so this is only a safety net.
    max_parallel_jobs: int = 16
    max_upload_bytes: int = 30 * 1024 * 1024
    # Options switched off for everyone (they are hidden in the UI and refused by the API).
    disabled_models: tuple = ()   # model family keys, e.g. "gemini-3.1-flash-lite-image"
    disabled_sizes: tuple = ()    # e.g. "4K"
    max_count: int = 4            # most images one card may ask for at once
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
    for key in ("flow_base_url", "flow_api_key", "host"):
        if raw.get(key):
            setattr(s, key, str(raw[key]).strip())
    for key, cast in (("port", int), ("job_timeout", float), ("max_parallel_jobs", int),
                      ("max_upload_bytes", int)):
        if raw.get(key) is not None:
            setattr(s, key, cast(raw[key]))
    s.disabled_models = tuple(str(x).strip() for x in (raw.get("disabled_models") or []) if str(x).strip())
    s.disabled_sizes = tuple(str(x).strip().upper() for x in (raw.get("disabled_sizes") or []) if str(x).strip())
    if raw.get("max_count") is not None:
        s.max_count = max(1, min(8, int(raw["max_count"])))
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
    s.flow_base_url = s.flow_base_url.rstrip("/")
    return s
