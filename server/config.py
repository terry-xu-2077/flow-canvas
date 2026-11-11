"""Runtime configuration (config.json next to the project, overridable by env vars)."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


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
    if raw.get("data_dir"):
        d = Path(raw["data_dir"])
        s.data_dir = d if d.is_absolute() else ROOT / d
    s.flow_base_url = s.flow_base_url.rstrip("/")
    return s
