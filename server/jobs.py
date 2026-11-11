"""Background generation jobs: each job is one flow2api image request."""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import Optional

from .assets import AssetError, asset_path, save_image_bytes
from .config import Settings
from .db import Store
from .flow import FlowClient, FlowError

FINAL = {"done", "failed", "cancelled"}


class JobRunner:
    def __init__(self, settings: Settings, store: Store, flow: FlowClient):
        self.settings = settings
        self.store = store
        self.flow = flow
        self._sem = asyncio.Semaphore(max(1, settings.max_parallel_jobs))
        self._tasks: dict[str, asyncio.Task] = {}

    def submit(self, *, user: str, board: Optional[str], node: Optional[str], model: str,
               prompt: str, refs: list[str], count: int = 1) -> list[str]:
        ids = []
        for _ in range(max(1, min(int(count), 8))):
            job_id = uuid.uuid4().hex[:16]
            self.store.create_job({"id": job_id, "user": user, "board": board, "node": node,
                                   "model": model, "prompt": prompt, "refs": refs})
            task = asyncio.create_task(self._run(job_id))
            self._tasks[job_id] = task
            task.add_done_callback(lambda _t, j=job_id: self._tasks.pop(j, None))
            ids.append(job_id)
        return ids

    def cancel(self, job_id: str) -> bool:
        task = self._tasks.get(job_id)
        if task and not task.done():
            task.cancel()
            return True
        return False

    async def shutdown(self) -> None:
        for task in list(self._tasks.values()):
            task.cancel()
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    async def _progress(self, job_id: str, text: str) -> None:
        self.store.update_job(job_id, progress=text[:200])

    async def _run(self, job_id: str) -> None:
        job = self.store.get_job(job_id)
        if not job:
            return
        try:
            async with self._sem:
                self.store.update_job(job_id, status="running", started=time.time(), progress="准备中…")
                await asyncio.wait_for(self._execute(job), timeout=self.settings.job_timeout)
        except asyncio.CancelledError:
            self.store.update_job(job_id, status="cancelled", finished=time.time(), progress="已取消")
            raise
        except asyncio.TimeoutError:
            self.store.update_job(job_id, status="failed", finished=time.time(), error="生成超时")
        except (FlowError, AssetError) as exc:
            self.store.update_job(job_id, status="failed", finished=time.time(), error=str(exc)[:400])
        except Exception as exc:  # keep one bad job from killing the runner
            self.store.update_job(job_id, status="failed", finished=time.time(),
                                  error=f"{type(exc).__name__}: {exc}"[:400])

    async def _execute(self, job: dict) -> None:
        job_id = job["id"]
        ref_ids: list[str] = []
        for asset_id in job["refs"]:
            asset = self.store.get_asset(asset_id)
            path = asset_path(self.settings, asset_id)
            if not asset or not path.exists():
                raise FlowError("参考图已不存在，请重新添加")
            await self._progress(job_id, f"上传参考图 {len(ref_ids) + 1}/{len(job['refs'])}…")
            ref = await self.flow.upload_ref(path.read_bytes(), asset.get("flow_ref"))
            if ref != asset.get("flow_ref"):
                self.store.set_flow_ref(asset_id, ref)
            ref_ids.append(ref)

        async def on_progress(text: str) -> None:
            await self._progress(job_id, text)

        url = await self.flow.generate(job["model"], job["prompt"], ref_ids, on_progress)
        await self._progress(job_id, "下载结果…")
        data = await self.flow.download(url)
        saved = save_image_bytes(self.settings, self.store, data)
        self.store.update_job(job_id, status="done", finished=time.time(), progress="完成",
                              result_asset=saved["id"], error=None)
