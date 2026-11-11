"""Async client for the flow2api OpenAI-compatible gateway (image generation only)."""
from __future__ import annotations

import json
import re
import time
from typing import Awaitable, Callable, Optional
from urllib.parse import urlsplit

import httpx

IMG_RE = re.compile(
    r"^(gemini-[\d.]+-[a-z-]*?image)-(landscape|portrait|square|four-three|three-four)(?:-(2k|4k))?$")
ASPECT_TO_RATIO = {"landscape": "16:9", "portrait": "9:16", "square": "1:1",
                   "four-three": "4:3", "three-four": "3:4"}
RATIO_TO_ASPECT = {v: k for k, v in ASPECT_TO_RATIO.items()}
URL_RE = re.compile(r"""https?://[^\s"'<>()\]]+""")
MD_IMG_RE = re.compile(r"!\[[^\]]*\]\((https?://[^)\s]+)\)")
CAPTCHA_RE = re.compile(r"打码|验证码|reCAPTCHA|captcha", re.I)
PICTURE_TAG_RE = re.compile(r"<Picture\s+(\d+)>(?=([0-9A-Za-z])?)", re.I)
CACHE_TTL = 600.0


class FlowError(Exception):
    pass


def _is_error_line(line: str) -> bool:
    return line.startswith(("错误", "❌")) or line.lower().startswith("error") or "生成失败" in line


def mentions_to_text(prompt: str) -> str:
    """<Picture N> tags (as written by the prompt editor) -> 图片N, N = upload order of the references."""
    # a trailing space keeps "图片1" + "2个人" from reading as 图片12
    return PICTURE_TAG_RE.sub(lambda m: f"图片{int(m.group(1))}" + (" " if m.group(2) else ""), prompt)


def friendly_progress(line: str) -> str:
    """Hide captcha internals from users; shorten the progress prefix."""
    if CAPTCHA_RE.search(line):
        return "正在生成中…"
    return re.sub(r"^生成进度[:：]\s*", "生成中 ", line).strip()


def build_catalog(model_ids: dict[str, str]) -> list[dict]:
    """Group the expanded model names from /v1/models into families with ratio/size options."""
    families: dict[str, dict] = {}
    for mid, desc in model_ids.items():
        m = IMG_RE.match(mid)
        if not m:
            continue
        key, aspect, size = m.group(1), m.group(2), (m.group(3) or "1k").upper()
        fam = families.setdefault(key, {
            "key": key, "name": (desc.split("·")[0].strip() or key), "aspects": set(), "sizes": set()})
        fam["aspects"].add(aspect)
        fam["sizes"].add(size)
    out = []
    for fam in families.values():
        ratios = [r for r, a in RATIO_TO_ASPECT.items() if a in fam["aspects"]]
        sizes = [s for s in ("1K", "2K", "4K") if s in fam["sizes"]]
        out.append({"key": fam["key"], "name": fam["name"], "ratios": ratios, "sizes": sizes})
    rank = {"gemini-3.1-flash-image": 0, "gemini-3.0-pro-image": 1}
    out.sort(key=lambda x: (rank.get(x["key"], 2), x["name"]))
    return out


def model_id(key: str, ratio: str, size: str) -> str:
    aspect = RATIO_TO_ASPECT.get(ratio or "16:9")
    if not aspect:
        raise FlowError(f"不支持的比例：{ratio}")
    size = (size or "1K").upper()
    return f"{key}-{aspect}" + ("" if size == "1K" else f"-{size.lower()}")


class FlowClient:
    def __init__(self, base_url: str, api_key: str, *, transport: Optional[httpx.AsyncBaseTransport] = None,
                 timeout: float = 900.0):
        self.base = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self._http = httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(30.0, read=timeout))
        self._catalog: Optional[tuple[float, list[dict]]] = None

    async def close(self) -> None:
        await self._http.aclose()

    def _headers(self, extra: Optional[dict] = None) -> dict:
        h = {"Authorization": f"Bearer {self.api_key}"}
        if extra:
            h.update(extra)
        return h

    async def health(self) -> dict:
        r = await self._http.get(self.base + "/health", timeout=8)
        r.raise_for_status()
        return r.json()

    async def models(self, refresh: bool = False) -> list[dict]:
        if self._catalog and not refresh and time.time() - self._catalog[0] < CACHE_TTL:
            return self._catalog[1]
        r = await self._http.get(self.base + "/v1/models", headers=self._headers(), timeout=20)
        if r.status_code >= 400:
            raise FlowError(f"读取模型列表失败 HTTP {r.status_code}: {r.text[:200]}")
        data = r.json().get("data") or []
        ids = {m["id"]: (m.get("description") or "") for m in data if m.get("id")}
        catalog = build_catalog(ids)
        self._catalog = (time.time(), catalog)
        return catalog

    async def upload_ref(self, content: bytes, cached_ref: Optional[str]) -> str:
        """Return a ref://id for these bytes, re-using a still-valid earlier upload."""
        if cached_ref:
            r = await self._http.head(f"{self.base}/v1/media/{cached_ref}", headers=self._headers(), timeout=20)
            if r.status_code == 200:
                return cached_ref
        r = await self._http.post(self.base + "/v1/media/upload", content=content,
                                  headers=self._headers({"Content-Type": "application/octet-stream"}),
                                  timeout=300)
        if r.status_code >= 400:
            raise FlowError(f"上传参考图失败 HTTP {r.status_code}: {r.text[:200]}")
        return r.json()["id"]

    def fix_url(self, url: str) -> str:
        """flow2api caches results under its own configured base URL; talk to it via ours."""
        p = urlsplit(url)
        if p.path.startswith("/tmp/"):
            return self.base + p.path + (f"?{p.query}" if p.query else "")
        return url

    async def generate(self, model: str, prompt: str, ref_ids: list[str],
                       on_progress: Optional[Callable[[str], Awaitable[None]]] = None) -> str:
        """Run one image generation, return the result image URL."""
        if ref_ids:
            content: list | str = [{"type": "text", "text": prompt}] + [
                {"type": "image_url", "image_url": {"url": f"ref://{rid}"}} for rid in ref_ids]
        else:
            content = prompt
        body = {"model": model, "messages": [{"role": "user", "content": content}], "stream": True}
        text, errors, last = "", [], ""
        async with self._http.stream(
                "POST", self.base + "/v1/chat/completions", json=body,
                headers=self._headers({"Accept": "text/event-stream"})) as resp:
            if resp.status_code >= 400:
                detail = (await resp.aread()).decode("utf-8", "replace")[:300]
                raise FlowError(f"生成请求被拒绝 HTTP {resp.status_code}: {_error_message(detail)}")
            async for raw in resp.aiter_lines():
                line = raw.strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    obj = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if obj.get("error"):
                    err = obj["error"]
                    errors.append(str(err.get("message") if isinstance(err, dict) else err))
                    continue
                for ch in obj.get("choices") or []:
                    delta = ch.get("delta") or ch.get("message") or {}
                    piece = (delta.get("content") or "") + (delta.get("reasoning_content") or "")
                    if not piece:
                        continue
                    text += piece
                    for ln in piece.splitlines():
                        ln = ln.strip()
                        if not ln:
                            continue
                        if _is_error_line(ln):
                            errors.append(ln)
                        elif not URL_RE.search(ln):
                            shown = friendly_progress(ln)
                            if on_progress and shown and shown != last:
                                last = shown
                                await on_progress(shown)
        urls = MD_IMG_RE.findall(text) or URL_RE.findall(text)
        if not urls:
            raise FlowError("；".join(errors) or text.strip()[-200:] or "生成服务没有返回结果")
        return urls[-1]

    async def download(self, url: str) -> bytes:
        url = self.fix_url(url)
        headers = self._headers() if url.startswith(self.base) else None
        r = await self._http.get(url, headers=headers, timeout=120)
        if r.status_code >= 400:
            raise FlowError(f"下载结果失败 HTTP {r.status_code}")
        return r.content


def _error_message(detail: str) -> str:
    try:
        obj = json.loads(detail)
        err = obj.get("error", obj)
        return str(err.get("message") if isinstance(err, dict) else err)[:200]
    except Exception:
        return detail[:200]
