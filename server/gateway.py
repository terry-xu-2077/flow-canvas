"""Client for the terry2api aggregation API: models, credits, media, generation tasks, result files."""
from __future__ import annotations

from typing import Optional

import httpx

from .errors import GenError


class GatewayClient:
    def __init__(self, base_url: str, api_key: str = "", *, transport: Optional[httpx.AsyncBaseTransport] = None):
        self.base = base_url.rstrip("/")
        self.api_key = api_key
        self._http = httpx.AsyncClient(transport=transport, trust_env=False, timeout=httpx.Timeout(15.0, read=120.0))

    @property
    def enabled(self) -> bool:
        return bool(self.base)

    async def close(self) -> None:
        await self._http.aclose()

    async def _call(self, method: str, path: str, *, timeout: Optional[float] = None, headers: Optional[dict] = None, **kw) -> httpx.Response:
        if not self.enabled:
            raise GenError("没有配置聚合API（设置 → 聚合API，或 config.json 的 gateway_url）")
        headers = {**({"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}), **(headers or {})}
        try:
            r = await self._http.request(method, self.base + path, headers=headers, timeout=timeout, **kw)
        except httpx.TransportError as exc:
            raise GenError(f"无法连接聚合API（{self.base}）：{type(exc).__name__}")
        if r.status_code >= 400:
            raise GenError(_message(r))
        return r

    async def providers(self) -> dict:
        return (await self._call("GET", "/v1/providers", timeout=30)).json()

    async def models(self, kind: str = "video") -> dict:
        return (await self._call("GET", "/v1/models", params={"kind": kind}, timeout=120)).json()

    async def model_info(self, provider: str, kind: str, name: str) -> dict:
        return (await self._call("GET", "/v1/model_info", params={"provider": provider, "kind": kind, "name": name},
                                 timeout=120)).json()

    async def media_upload(self, data: bytes) -> str:
        """Put a picture in the gateway's library (content-addressed: the same bytes give the same id)."""
        r = await self._call("POST", "/v1/media", content=data, headers={"Content-Type": "application/octet-stream"}, timeout=300)
        return r.json()["id"]

    async def media_exists(self, mid: str) -> bool:
        try:
            await self._call("HEAD", f"/v1/media/{mid}", timeout=20)
            return True
        except GenError:
            return False

    async def credits(self, live: bool = False) -> dict:
        return (await self._call("GET", "/v1/credits", params={"live": str(live).lower()}, timeout=90)).json()

    async def quote(self, params: dict) -> dict:  # params carry kind=image|video
        """What a task costs in credits (terry2api asks the platform through the browser extension; read-only)."""
        return (await self._call("GET", "/v1/prices/quote", params=params, timeout=90)).json()

    async def balances(self) -> dict:
        return (await self._call("GET", "/v1/balances", timeout=90)).json()

    async def submit(self, body: dict, kind: str = "video") -> dict:
        return (await self._call("POST", f"/v1/{kind}/generations", json=body, timeout=300)).json()

    async def task(self, task_id: str) -> dict:
        return (await self._call("GET", f"/v1/tasks/{task_id}", timeout=30)).json()

    async def cancel(self, task_id: str) -> None:
        await self._call("POST", f"/v1/tasks/{task_id}/cancel", timeout=15)

    async def download(self, url: str) -> bytes:
        """A result file (the task's output url is relative to the service)."""
        path = url if url.startswith("/") else "/" + url
        return (await self._call("GET", path, timeout=900)).content


def _message(r: httpx.Response) -> str:
    try:
        err = r.json().get("error", r.json())
        return str(err.get("message") if isinstance(err, dict) else err)[:400]
    except Exception:
        return f"HTTP {r.status_code}: {r.text[:200]}"
