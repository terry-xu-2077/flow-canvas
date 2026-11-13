"""Tiny SQLite store: boards, assets, jobs. One connection guarded by a lock (LAN-scale load)."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS boards (
    user TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}', created REAL NOT NULL, updated REAL NOT NULL,
    PRIMARY KEY (user, id)
);
CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY, mime TEXT NOT NULL, w INTEGER, h INTEGER, size INTEGER,
    flow_ref TEXT, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, user TEXT NOT NULL, board TEXT, node TEXT,
    model TEXT NOT NULL, prompt TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '', error TEXT,
    result_asset TEXT, created REAL NOT NULL, started REAL, finished REAL
);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs (user, created);
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, avatar TEXT NOT NULL DEFAULT '', created REAL NOT NULL
);
"""


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(SCHEMA)
            self._db.commit()
        self._migrate_users()
        self._migrate_jobs()

    # -- helpers
    def _one(self, sql: str, args: tuple = ()) -> Optional[dict]:
        with self._lock:
            row = self._db.execute(sql, args).fetchone()
        return dict(row) if row else None

    def _all(self, sql: str, args: tuple = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._db.execute(sql, args).fetchall()]

    def _run(self, sql: str, args: tuple = ()) -> int:
        with self._lock:
            cur = self._db.execute(sql, args)
            self._db.commit()
            return cur.rowcount

    def _migrate_jobs(self) -> None:
        with self._lock:
            cols = {r[1] for r in self._db.execute("PRAGMA table_info(jobs)")}
            if "extra" not in cols:
                self._db.execute("ALTER TABLE jobs ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'")
                self._db.commit()

    # -- boards
    # -- users (id is a random uuid; boards.user / jobs.user hold that id, the name can change)
    def _migrate_users(self) -> None:
        """Boards and jobs used to be keyed by the user's name: give each such name a user row and re-key the rows."""
        with self._lock:
            known = {r["id"] for r in self._db.execute("SELECT id FROM users")}
            names = {r[0] for r in self._db.execute("SELECT user FROM boards UNION SELECT user FROM jobs")}
            for name in sorted(names - known):
                row = self._db.execute("SELECT id FROM users WHERE name=?", (name,)).fetchone()
                uid = row["id"] if row else uuid.uuid4().hex
                if not row:
                    self._db.execute("INSERT INTO users (id,name,avatar,created) VALUES (?,?,?,?)", (uid, name, "", time.time()))
                self._db.execute("UPDATE boards SET user=? WHERE user=?", (uid, name))
                self._db.execute("UPDATE jobs SET user=? WHERE user=?", (uid, name))
            self._db.commit()

    def list_users(self) -> list[dict]:
        return self._all(
            "SELECT u.id, u.name, u.avatar, COUNT(b.id) AS boards, COALESCE(MAX(b.updated), u.created) AS updated "
            "FROM users u LEFT JOIN boards b ON b.user=u.id GROUP BY u.id ORDER BY updated DESC")

    def get_user(self, user_id: str) -> Optional[dict]:
        return self._one("SELECT id, name, avatar, created FROM users WHERE id=?", (user_id,))

    def get_user_by_name(self, name: str) -> Optional[dict]:
        return self._one("SELECT id, name, avatar, created FROM users WHERE name=?", (name,))

    def create_user(self, name: str) -> dict:
        """Raises sqlite3.IntegrityError when the name is taken."""
        uid = uuid.uuid4().hex
        self._run("INSERT INTO users (id,name,avatar,created) VALUES (?,?,?,?)", (uid, name, "", time.time()))
        return self.get_user(uid)  # type: ignore[return-value]

    def update_user(self, user_id: str, name: Optional[str] = None, avatar: Optional[str] = None) -> None:
        if name is not None:
            self._run("UPDATE users SET name=? WHERE id=?", (name, user_id))
        if avatar is not None:
            self._run("UPDATE users SET avatar=? WHERE id=?", (avatar, user_id))

    # -- boards
    def list_boards(self, user: str) -> list[dict]:
        return self._all(
            "SELECT id, name, created, updated FROM boards WHERE user=? ORDER BY updated DESC", (user,))

    def create_board(self, user: str, board_id: str, name: str) -> dict:
        now = time.time()
        self._run("INSERT INTO boards (user,id,name,data,created,updated) VALUES (?,?,?,?,?,?)",
                  (user, board_id, name, "{}", now, now))
        return {"id": board_id, "name": name, "created": now, "updated": now}

    def get_board(self, user: str, board_id: str) -> Optional[dict]:
        row = self._one("SELECT id, name, data, created, updated FROM boards WHERE user=? AND id=?",
                        (user, board_id))
        if row:
            row["data"] = json.loads(row["data"] or "{}")
        return row

    def save_board(self, user: str, board_id: str, data: dict, name: Optional[str] = None) -> bool:
        blob = json.dumps(data, ensure_ascii=False)
        if name is None:
            n = self._run("UPDATE boards SET data=?, updated=? WHERE user=? AND id=?",
                          (blob, time.time(), user, board_id))
        else:
            n = self._run("UPDATE boards SET data=?, name=?, updated=? WHERE user=? AND id=?",
                          (blob, name, time.time(), user, board_id))
        return n > 0

    def rename_board(self, user: str, board_id: str, name: str) -> bool:
        return self._run("UPDATE boards SET name=?, updated=? WHERE user=? AND id=?",
                         (name, time.time(), user, board_id)) > 0

    def delete_board(self, user: str, board_id: str) -> bool:
        return self._run("DELETE FROM boards WHERE user=? AND id=?", (user, board_id)) > 0

    # -- assets
    def put_asset(self, asset_id: str, mime: str, w: int, h: int, size: int) -> None:
        self._run("INSERT INTO assets (id,mime,w,h,size,created) VALUES (?,?,?,?,?,?) "
                  "ON CONFLICT(id) DO UPDATE SET created=excluded.created",  # re-uploading counts as using it again
                  (asset_id, mime, w, h, size, time.time()))

    def get_asset(self, asset_id: str) -> Optional[dict]:
        return self._one("SELECT * FROM assets WHERE id=?", (asset_id,))

    def set_flow_ref(self, asset_id: str, ref: Optional[str]) -> None:
        self._run("UPDATE assets SET flow_ref=? WHERE id=?", (ref, asset_id))

    # -- jobs
    def create_job(self, job: dict[str, Any]) -> None:
        self._run(
            "INSERT INTO jobs (id,user,board,node,model,prompt,refs,status,progress,created,extra)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (job["id"], job["user"], job.get("board"), job.get("node"), job["model"], job["prompt"],
             json.dumps(job.get("refs") or []), "queued", "", time.time(), json.dumps(job.get("extra") or {})))

    def merge_extra(self, job_id: str, patch: dict) -> None:
        with self._lock:
            row = self._db.execute("SELECT extra FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                return
            cur = json.loads(row[0] or "{}")
            cur.update(patch)
            self._db.execute("UPDATE jobs SET extra=? WHERE id=?", (json.dumps(cur), job_id))
            self._db.commit()

    def recent_done(self, limit: int = 80) -> list[dict]:
        return self._all("SELECT extra, started, finished FROM jobs WHERE status='done' AND started IS NOT NULL "
                         "ORDER BY finished DESC LIMIT ?", (limit,))

    def update_job(self, job_id: str, **fields: Any) -> None:
        if not fields:
            return
        cols = ", ".join(f"{k}=?" for k in fields)
        self._run(f"UPDATE jobs SET {cols} WHERE id=?", (*fields.values(), job_id))

    def get_job(self, job_id: str) -> Optional[dict]:
        row = self._one("SELECT * FROM jobs WHERE id=?", (job_id,))
        if row:
            row["refs"] = json.loads(row["refs"] or "[]")
            row["extra"] = json.loads(row.get("extra") or "{}")
        return row

    def get_jobs(self, ids: list[str]) -> list[dict]:
        if not ids:
            return []
        marks = ",".join("?" for _ in ids)
        rows = self._all(f"SELECT * FROM jobs WHERE id IN ({marks})", tuple(ids))
        for row in rows:
            row["refs"] = json.loads(row["refs"] or "[]")
            row["extra"] = json.loads(row.get("extra") or "{}")
        return rows

    def fail_unfinished_jobs(self, message: str) -> int:
        return self._run(
            "UPDATE jobs SET status='failed', error=?, finished=? WHERE status IN ('queued','running')",
            (message, time.time()))

    def count_active_jobs(self) -> dict:
        rows = self._all("SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued','running') GROUP BY status")
        return {r["status"]: r["n"] for r in rows}
