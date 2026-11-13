"""Background generation jobs: each job is one flow2api image request."""
from __future__ import annotations

import asyncio
import json
import re
import statistics
import time
import uuid
from typing import Optional

import io

from PIL import Image

from .assets import AssetError, asset_path, save_image_bytes
from .comfy import ComfyClient, ComfyError
from .comfy_workflows import UPSCALERS
from .config import SIZE_ORDER, SIZE_TARGET
from .config import Settings
from .db import Store
from .flow import FlowClient, FlowError, mentions_to_text

FINAL = {"done", "failed", "cancelled"}


def job_percent(job: dict, now: float) -> int:
    """Progress guess for a running job: elapsed time against how long the Flow step and the ComfyUI enlarge step took
    for earlier jobs (the real step times are not reported by either service)."""
    ex = job.get("extra") or {}
    if job.get("status") != "running" or not job.get("started"):
        return 0
    est_f, est_u = float(ex.get("est_flow") or 45), float(ex.get("est_up") or 90)

    def frac(elapsed: float, est: float) -> float:
        return min(0.97, max(0.0, elapsed / est))

    if ex.get("standalone"):
        return int(frac(now - ex["up_start"], est_u) * 99) if ex.get("up_start") else 0
    if not ex.get("upscale_to"):
        return int(frac(now - job["started"], est_f) * 99)
    w1 = est_f / (est_f + est_u) * 100
    if "flow_done" not in ex:
        return int(frac(now - job["started"], est_f) * w1)
    if not ex.get("up_start"):
        return int(w1)
    return min(99, int(w1 + frac(now - ex["up_start"], est_u) * (100 - w1)))


class JobRunner:
    def __init__(self, settings: Settings, store: Store, flow: FlowClient):
        self.settings = settings
        self.store = store
        self.flow = flow
        self._sem = asyncio.Semaphore(max(1, settings.max_parallel_jobs))
        self._tasks: dict[str, asyncio.Task] = {}
        self._comfy_sem = asyncio.Semaphore(1)   # one GPU job at a time
        self._comfy: Optional[ComfyClient] = None

    def _estimates(self, target: Optional[int]) -> tuple[float, float]:
        """Typical seconds of the Flow step and of the enlarge step to `target`, from the latest finished jobs."""
        flow: list[float] = []
        up: list[float] = []
        for r in self.store.recent_done(80):
            ex = json.loads(r["extra"] or "{}")
            if "t_flow" in ex:
                flow.append(float(ex["t_flow"]))
            elif not ex.get("upscale_to") and not ex.get("standalone") and r["finished"] and r["started"]:
                flow.append(r["finished"] - r["started"])
            if ex.get("t_up") and ex.get("upscale_to") == target:
                up.append(float(ex["t_up"]))
        med = lambda xs, d: statistics.median(xs[:20]) if xs else d
        return med(flow, 45.0), med(up, 90.0)

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
                est_f, est_u = self._estimates(job["extra"].get("upscale_to"))
                job["extra"].update(est_flow=est_f, est_up=est_u)
                self.store.merge_extra(job_id, {"est_flow": est_f, "est_up": est_u})
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
        name = job["extra"].get("engine") or self.settings.comfy_engine
        engine = UPSCALERS.get(name)
        if not engine:
            raise ComfyError(f"未知的放大方案：{name}")
        cfg = self.settings.comfy_pid if name == "pid" else self.settings.comfy_seedvr2
        client = self.comfy_client()

        size = job["extra"].get("size") or next((z for z in SIZE_ORDER if SIZE_TARGET[z] == target), f"{target}px")
        tag = f"放大到 {size}" if job["extra"].get("standalone") else f"第 2 步 · 放大到 {size}"

        async def on_progress(text: str) -> None:
            await self._progress(job_id, f"{tag} · {text}")

        await self._progress(job_id, f"{tag} · 等待 ComfyUI…")
        async with self._comfy_sem:
            await self._progress(job_id, f"{tag} · 处理中…")
            t_up = time.time()
            self.store.merge_extra(job_id, {"up_start": t_up})
            job["extra"]["up_start"] = t_up
            name = await client.upload_image(data, f"terryflow_{job_id}.png")
            prompt, out = engine[1](name, w, h, target, cfg, job["prompt"] if not strict else "")
            result = await client.run_image(prompt, out, on_progress, self.settings.comfy_timeout)
            self.store.merge_extra(job_id, {"t_up": time.time() - t_up})
            return result

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

        # a 4K / 6K card is two steps: Flow makes a smaller picture (its own 2K stage also says "放大到 2K"), ComfyUI enlarges it
        m = re.search(r"-(2k|4k)$", job["model"])
        step = f"第 1 步 · Flow 出图 {m.group(1).upper() if m else '1K'} · " if extra.get("upscale_to") else ""

        async def on_progress(text: str) -> None:
            await self._progress(job_id, step + text)

        url = await self.flow.generate(job["model"], mentions_to_text(job["prompt"], len(ref_ids)), ref_ids, on_progress)
        await self._progress(job_id, step + "下载结果…")
        data = await self.flow.download(url)
        now = time.time()
        extra["flow_done"] = now
        self.store.merge_extra(job_id, {"flow_done": now, "t_flow": now - (self.store.get_job(job_id) or {}).get("started", now)})
        if extra.get("upscale_to"):
            data = await self._upscale(job, data, False)
        saved = save_image_bytes(self.settings, self.store, data, limit=not extra.get("upscale_to"))
        self.store.update_job(job_id, status="done", finished=time.time(), progress="完成",
                              result_asset=saved["id"], error=None)
