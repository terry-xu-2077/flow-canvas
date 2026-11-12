"""Client for a local ComfyUI server (HTTP API): upload an image, queue an API-format workflow, wait, fetch the result.

Kept generic on purpose: upscaling is the first user, later features (image edit, text-to-image, video, prompt
enhancement) only need a new workflow builder in comfy_workflows.py and a call to ComfyClient.run_image().
"""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import Awaitable, Callable, Optional

import httpx

Progress = Callable[[str], Awaitable[None]]


class ComfyError(RuntimeError):
    pass


def _node_errors(body: dict) -> str:
    """Readable text from a /prompt validation failure."""
    parts: list[str] = []
    err = body.get("error")
    if isinstance(err, dict):
        parts.append(str(err.get("message") or err.get("type") or ""))
    for nid, info in (body.get("node_errors") or {}).items():
        for e in info.get("errors", []):
            parts.append(f"{info.get('class_type', nid)}: {e.get('message', '')} {e.get('details', '')}".strip())
    return "；".join(p for p in parts if p)[:400] or "工作流被 ComfyUI 拒绝"


class ComfyClient:
    def __init__(self, base_url: str, *, transport: Optional[httpx.AsyncBaseTransport] = None, poll: float = 1.5):
        self.base = base_url.rstrip("/")
        self.poll = poll
        self.client_id = uuid.uuid4().hex
        self._http = httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(30.0, read=300.0))

    async def close(self) -> None:
        await self._http.aclose()

    async def _get(self, path: str, **kw) -> httpx.Response:
        try:
            return await self._http.get(self.base + path, **kw)
        except httpx.HTTPError as exc:
            raise ComfyError(f"无法连接 ComfyUI（{self.base}）：{type(exc).__name__}") from exc

    async def ping(self) -> dict:
        r = await self._get("/system_stats", timeout=6)
        if r.status_code >= 400:
            raise ComfyError(f"ComfyUI 返回 HTTP {r.status_code}")
        return r.json()

    async def object_info(self, node: str) -> dict:
        r = await self._get(f"/object_info/{node}", timeout=15)
        return r.json().get(node, {}) if r.status_code == 200 else {}

    async def upload_image(self, data: bytes, filename: str) -> str:
        try:
            r = await self._http.post(self.base + "/upload/image", data={"overwrite": "true", "type": "input"},
                                      files={"image": (filename, data, "application/octet-stream")}, timeout=120)
        except httpx.HTTPError as exc:
            raise ComfyError(f"无法连接 ComfyUI（{self.base}）：{type(exc).__name__}") from exc
        if r.status_code >= 400:
            raise ComfyError(f"上传图片到 ComfyUI 失败 HTTP {r.status_code}")
        info = r.json()
        return f"{info['subfolder']}/{info['name']}" if info.get("subfolder") else info["name"]

    async def queue(self, prompt: dict) -> str:
        try:
            r = await self._http.post(self.base + "/prompt", json={"prompt": prompt, "client_id": self.client_id}, timeout=30)
        except httpx.HTTPError as exc:
            raise ComfyError(f"无法连接 ComfyUI（{self.base}）：{type(exc).__name__}") from exc
        if r.status_code >= 400:
            try:
                raise ComfyError(_node_errors(r.json()))
            except ValueError:
                raise ComfyError(f"ComfyUI 拒绝了任务 HTTP {r.status_code}") from None
        return r.json()["prompt_id"]

    async def cancel(self, prompt_id: str) -> None:
        """Best effort: remove it from the queue, interrupt it when it is the one running."""
        try:
            await self._http.post(self.base + "/queue", json={"delete": [prompt_id]}, timeout=10)
            q = (await self._http.get(self.base + "/queue", timeout=10)).json()
            if any(len(it) > 1 and it[1] == prompt_id for it in q.get("queue_running", [])):
                await self._http.post(self.base + "/interrupt", json={"prompt_id": prompt_id}, timeout=10)
        except Exception:
            pass

    async def wait(self, prompt_id: str, on_progress: Optional[Progress] = None, timeout: float = 1800.0) -> dict:
        """Poll until the prompt finishes; returns its history entry."""
        deadline = time.monotonic() + timeout
        last = ""
        while time.monotonic() < deadline:
            r = await self._get(f"/history/{prompt_id}", timeout=15)
            hist = r.json().get(prompt_id) if r.status_code == 200 else None
            if hist:
                st = hist.get("status") or {}
                if st.get("status_str") == "error":
                    msgs = [m[1] for m in st.get("messages", []) if m and m[0] == "execution_error"]
                    detail = (msgs[0].get("exception_message") if msgs else "") or "ComfyUI 执行出错"
                    raise ComfyError(str(detail).strip()[:400])
                if st.get("completed", True) or hist.get("outputs"):
                    return hist
            text = "处理中…"
            q = await self._get("/queue", timeout=15)
            if q.status_code == 200:
                body = q.json()
                pending = [it[1] for it in body.get("queue_pending", []) if len(it) > 1]
                if prompt_id in pending:
                    text = f"排队中（前面 {pending.index(prompt_id) + len(body.get('queue_running', []))} 个）…"
            if on_progress and text != last:
                last = text
                await on_progress(text)
            await asyncio.sleep(self.poll)
        raise ComfyError("ComfyUI 处理超时")

    async def view(self, filename: str, subfolder: str = "", kind: str = "output") -> bytes:
        r = await self._get("/view", params={"filename": filename, "subfolder": subfolder, "type": kind}, timeout=180)
        if r.status_code >= 400:
            raise ComfyError(f"读取 ComfyUI 结果失败 HTTP {r.status_code}")
        return r.content

    async def run_image(self, prompt: dict, output_node: str, on_progress: Optional[Progress] = None,
                        timeout: float = 1800.0) -> bytes:
        """Queue a workflow and return the first image saved by `output_node`."""
        pid = await self.queue(prompt)
        try:
            hist = await self.wait(pid, on_progress, timeout)
        except asyncio.CancelledError:
            await self.cancel(pid)
            raise
        images = (hist.get("outputs", {}).get(output_node) or {}).get("images") or []
        if not images:
            raise ComfyError("ComfyUI 没有输出图片")
        im = images[0]
        return await self.view(im["filename"], im.get("subfolder", ""), im.get("type", "output"))
