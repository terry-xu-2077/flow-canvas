"""Client for the local gpt2api gateway: ChatGPT (web, Plus account) behind an OpenAI-style images API.

Image generation only. gpt2api drives one ChatGPT conversation at a time and a picture takes roughly
30-80 seconds, so a job here simply waits; requests from several cards queue up inside gpt2api.
"""
from __future__ import annotations

import asyncio
import base64
import re
import time
from typing import Awaitable, Callable, Optional

import httpx

from .flow import PICTURE_TAG_RE, FlowError

GPT_KEY = "gpt-image"
GPT_PREFIX = "gpt:"
# card ratio -> the `size` gpt2api turns into a "composition" hint for ChatGPT
RATIO_SIZE = {"1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536", "16:9": "1792x1024", "9:16": "1024x1792"}
HEALTH_TTL = 10.0


def is_gpt_model(model: str) -> bool:
    return model.startswith(GPT_PREFIX)


def mentions_to_ordinals(prompt: str, n_refs: int) -> str:
    """<Picture N> -> "第N张图" (ChatGPT has no @ syntax); a tag outside the list is dropped."""
    def one(m: re.Match) -> str:
        n = int(m.group(1))
        return f"第{n}张图" if 1 <= n <= n_refs else ""
    return PICTURE_TAG_RE.sub(one, prompt)


def gpt_model_id(key: str, ratio: str) -> str:
    return f"{GPT_PREFIX}{key}:{ratio}"


def split_gpt_model(model: str) -> tuple[str, str]:
    _, key, ratio = model.split(":", 2)
    return key, ratio


class GptClient:
    def __init__(self, base_url: str, api_key: str = "", *, transport: Optional[httpx.AsyncBaseTransport] = None,
                 timeout: float = 900.0):
        self.base = base_url.rstrip("/")
        self.api_key = api_key
        self._http = httpx.AsyncClient(transport=transport, trust_env=False, timeout=httpx.Timeout(10.0, read=timeout))
        self._health: Optional[tuple[float, bool]] = None

    @property
    def enabled(self) -> bool:
        return bool(self.base)

    async def close(self) -> None:
        await self._http.aclose()

    def _headers(self, extra: Optional[dict] = None) -> dict:
        return {**({"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}), **(extra or {})}

    async def available(self) -> bool:
        """gpt2api is up *and* its browser extension is connected (cached for a few seconds)."""
        if self._health and time.monotonic() - self._health[0] < HEALTH_TTL:
            return self._health[1]
        try:
            r = await self._http.get(self.base + "/health", timeout=3)
            ok = r.status_code == 200 and bool(r.json().get("extension_connected"))
        except (httpx.HTTPError, ValueError):
            ok = False
        self._health = (time.monotonic(), ok)
        return ok

    async def quota(self) -> Optional[dict]:
        """gpt2api's own image quota: {"hour": {...}, "day": {...}} (None when it cannot be read)."""
        if not self.enabled:
            return None
        try:
            r = await self._http.get(self.base + "/v1/quota", headers=self._headers(), timeout=5)
            r.raise_for_status()
            q = r.json()["image"]
            return q if isinstance(q, dict) and "hour" in q and "day" in q else None
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            return None

    async def catalog(self) -> list[dict]:
        if not self.enabled:
            return []
        return [{"key": GPT_KEY, "name": "GPT Image", "ratios": list(RATIO_SIZE), "sizes": ["1K"],
                 "provider": "gpt", "tag": "ChatGPT", "refs": True, "available": await self.available()}]

    async def upload_ref(self, content: bytes, cached_ref: Optional[str]) -> str:
        """Return a ref_… id for these bytes, re-using a still-valid earlier upload (same scheme as the Flow client)."""
        if cached_ref:
            try:
                r = await self._http.head(f"{self.base}/v1/media/{cached_ref}", headers=self._headers(), timeout=10)
                if r.status_code == 200:
                    return cached_ref
            except httpx.TransportError:
                pass
        try:
            r = await self._http.post(self.base + "/v1/media/upload", content=content,
                                      headers=self._headers({"Content-Type": "application/octet-stream"}), timeout=60)
        except httpx.TransportError as exc:
            raise FlowError(f"无法连接 gpt2api（{self.base}）：{type(exc).__name__}")
        if r.status_code >= 400:
            raise FlowError(f"上传参考图失败：{_message(r)}")
        return r.json()["id"]

    async def generate(self, prompt: str, ratio: str, images: Optional[list[str]] = None,
                       on_progress: Optional[Callable[[str], Awaitable[None]]] = None) -> bytes:
        """Generate one picture and return its bytes."""
        if not self.enabled:
            raise FlowError("没有配置 ChatGPT 生图服务（config.json 的 gpt_base_url）")
        size = RATIO_SIZE.get(ratio)
        if not size:
            raise FlowError(f"ChatGPT 生图不支持比例 {ratio}")
        started = time.monotonic()

        async def ticker() -> None:
            while on_progress:
                await on_progress(f"ChatGPT 生成中 · 已用 {int(time.monotonic() - started)} 秒")
                await asyncio.sleep(3)

        tick = asyncio.create_task(ticker())
        try:
            body: dict = {"prompt": prompt, "n": 1, "response_format": "b64_json"}
            if images:  # the prompt goes out as written; the pictures decide what ChatGPT makes of it
                body["images"] = images  # ref_… ids from upload_ref
            else:
                body["size"] = size
            url = "/v1/images/generations"
            r = await self._http.post(self.base + url, headers=self._headers(), json=body)
        except httpx.TransportError as exc:
            raise FlowError(f"无法连接 gpt2api（{self.base}）：{type(exc).__name__}")
        finally:
            tick.cancel()
        if r.status_code >= 400:
            raise FlowError(f"ChatGPT 生图失败：{_message(r)}")
        try:
            return base64.b64decode(r.json()["data"][0]["b64_json"])
        except (KeyError, IndexError, ValueError):
            raise FlowError("ChatGPT 生图没有返回图片")


def _message(r: httpx.Response) -> str:
    try:
        err = r.json().get("error", r.json())
        text = err.get("message") if isinstance(err, dict) else err
        return str(text or r.text)[:300]
    except Exception:
        return f"HTTP {r.status_code}: {r.text[:200]}"
