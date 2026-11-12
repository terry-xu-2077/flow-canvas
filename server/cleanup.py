"""Find and remove image files that no board, avatar or active job refers to any more."""
from __future__ import annotations

import re
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import Settings

ID_RE = re.compile(r"[0-9a-f]{40}")


@dataclass
class Scan:
    ids: list[str] = field(default_factory=list)
    bytes: int = 0
    kept_young: int = 0   # unreferenced but newer than the age limit
    total_files: int = 0


def _referenced(db: sqlite3.Connection) -> set[str]:
    refs: set[str] = set()
    for (data,) in db.execute("SELECT data FROM boards"):
        refs.update(ID_RE.findall(data or ""))
    for (avatar,) in db.execute("SELECT avatar FROM users"):
        refs.update(ID_RE.findall(avatar or ""))
    # anything a queued/running job still reads or is about to write
    for refs_json, result in db.execute("SELECT refs, result_asset FROM jobs WHERE status IN ('queued','running')"):
        refs.update(ID_RE.findall(refs_json or ""))
        if result:
            refs.add(result)
    return refs


def scan(settings: Settings, min_age_days: float) -> Scan:
    out = Scan()
    cutoff = time.time() - min_age_days * 86400
    db = sqlite3.connect(f"file:{settings.db_path.as_posix()}?mode=ro", uri=True, timeout=5)
    try:
        refs = _referenced(db)
        made = dict(db.execute("SELECT id, created FROM assets"))
    finally:
        db.close()
    for p in settings.assets_dir.iterdir():
        if not p.is_file() or not ID_RE.fullmatch(p.name):
            continue
        out.total_files += 1
        if p.name in refs:
            continue
        st = p.stat()
        if max(st.st_mtime, made.get(p.name, 0)) > cutoff:
            out.kept_young += 1
            continue
        out.ids.append(p.name)
        out.bytes += st.st_size
    return out


def delete(settings: Settings, ids: list[str]) -> tuple[int, int]:
    """Delete the files (and their thumbnails and asset rows). Returns (files, bytes freed)."""
    n = freed = 0
    thumbs = settings.assets_dir / "thumbs"
    for i in ids:
        p: Path = settings.assets_dir / i
        try:
            freed += p.stat().st_size
            p.unlink()
            n += 1
        except FileNotFoundError:
            pass
        if thumbs.is_dir():
            for t in thumbs.glob(f"{i}_*"):
                try:
                    freed += t.stat().st_size
                    t.unlink()
                except OSError:
                    pass
    db = sqlite3.connect(str(settings.db_path), timeout=10)
    try:
        db.executemany("DELETE FROM assets WHERE id=?", [(i,) for i in ids])
        db.commit()
    finally:
        db.close()
    return n, freed
