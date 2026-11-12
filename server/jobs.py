"""Background generation jobs: each job is one flow2api image request."""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import Optional

import io

from PIL import Image

from .assets import AssetError, asset_path, save_image_bytes
from .comfy import ComfyClient, ComfyError
from .comfy_workflows import UPSCALERS
from .config import Settings
from .db import Store
from .flow import FlowClient, FlowError, mentions_to_text

FINAL = {"done", "failed", "cancelled"}


class JobRunner:
    def __init__(self, settings: Settings, store: Store, flow: FlowClient):
        self.settings = settings
        self.store = store
        self.flow = flow
        self._sem = asyncio.Semaphore(max(1, settings.max_parallel_jobs))
        self._tasks: dict[str, asyncio.Task] = {}
        self._comfy_sem = asyncio.Semaphore(1)   # one GPU job at a time
        self._comfy: Optional[ComfyClient] = None

    def comfy_client(self) -> ComfyClient:
        if not self.settings.comfy_url:
            raise ComfyError("没有配置 ComfyUI，请在服务器控制台的设置里填写地址")
        if self._comfy is None or self._comfy.base != self.settings.comfy_url:
            self._comfy = ComfyClient(self.settings.comfy_url)
        return self._comfy

    def submit(self, *, user: str, board: Optional[str], node: Optional[str], model: str,
               prompt: str, refs: list[str], count: int = 1, extra: Optional[dict] = None) -> list[str]:
        ids = []
        for _ in range(max(1, min(int(count), 8))):
            job_id = uuid.uuid4().hex[:16]
            self.store.create_job({"id": job_id, "user": user, "board": board, "node": node,
                                   "model": model, "prompt": prompt, "refs": refs, "extra": extra or {}})
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
                limit = self.settings.job_timeout + (self.settings.comfy_timeout if job["extra"].get("upscale_to") else 0)
                await asyncio.wait_for(self._execute(job), timeout=limit)
        except asyncio.CancelledError:
            self.store.update_job(job_id, status="cancelled", finished=time.time(), progress="已取消")
            raise
        except asyncio.TimeoutError:
            self.store.update_job(job_id, status="failed", finished=time.time(), error="生成超时")
        except (FlowError, AssetError, ComfyError) as exc:
            self.store.update_job(job_id, status="failed", finished=time.time(), error=str(exc)[:400])
        except Exception as exc:  # keep one bad job from killing the runner
            self.store.update_job(job_id, status="failed", finished=time.time(),
                                  error=f"{type(exc).__name__}: {exc}"[:400])

    async def _upscale(self, job: dict, data: bytes, strict: bool) -> bytes:
        """Enlarge image bytes with ComfyUI so the long edge reaches job.extra.upscale_to."""
        job_id, target = job["id"], int(job["extra"]["upscale_to"])
        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
        if max(w, h) >= target * 0.98:
            if strict:
                raise ComfyError(f"这张图已经有 {max(w, h)} 像素，不需要放大到 {target}")
            return data
        engine = UPSCALERS.get(self.settings.comfy_engine)
        if not engine:
            raise ComfyError(f"未知的放大方案：{self.settings.comfy_engine}")
        cfg = self.settings.comfy_pid if self.settings.comfy_engine == "pid" else self.settings.comfy_seedvr2
        client = self.comfy_client()

        async def on_progress(text: str) -> None:
            await self._progress(job_id, text)

        await self._progress(job_id, "等待放大…")
        async with self._comfy_sem:
            await self._progress(job_id, "放大中…")
            name = await client.upload_image(data, f"terryflow_{job_id}.png")
            prompt, out = engine[1](name, w, h, target, cfg, job["prompt"] if not strict else "")
            return await client.run_image(prompt, out, on_progress, self.settings.comfy_timeout)

    async def _execute(self, job: dict) -> None:
        job_id = job["id"]
        extra = job["extra"]
        if extra.get("standalone"):
            src = asset_path(self.settings, job["refs"][0]) if job["refs"] else None
            if not src or not src.exists():
                raise FlowError("原图已不存在")
            out = await self._upscale(job, src.read_bytes(), True)
            saved = save_image_bytes(self.settings, self.store, out, limit=False)
            self.store.update_job(job_id, status="done", finished=time.time(), progress="完成",
                                  result_asset=saved["id"], error=None)
            return
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

        url = await self.flow.generate(job["model"], mentions_to_text(job["prompt"], len(ref_ids)), ref_ids, on_progress)
        await self._progress(job_id, "下载结果…")
        data = await self.flow.download(url)
        if extra.get("upscale_to"):
            data = await self._upscale(job, data, False)
        saved = save_image_bytes(self.settings, self.store, data, limit=not extra.get("upscale_to"))
        self.store.update_job(job_id, status="done", finished=time.time(), progress="完成",
                              result_asset=saved["id"], error=None)
