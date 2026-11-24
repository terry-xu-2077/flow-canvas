"""Pure rules of the canvas: which resolutions / models / options a user may pick and how prompts are rewritten (no I/O)."""
from __future__ import annotations

import re
from typing import Optional

from .config import SIZE_ORDER, SIZE_TARGET, Settings

PICTURE_TAG_RE = re.compile(r"<Picture\s+(\d+)>", re.I)


def resolve_size(settings: Settings, supported: list[str], size: str) -> Optional[tuple[str, Optional[int], str]]:
    """Where a resolution comes from: (size Flow generates, long edge to enlarge to with ComfyUI or None, enlarge
    engine), or None when this resolution is switched off / impossible for the model."""
    size = (size or "1K").upper()
    spec = settings.resolutions.get(size) or ({"route": "flow"} if size in supported else {"route": "off"})
    if size in settings.disabled_sizes or spec.get("route") == "off":
        return None
    if spec.get("route") == "comfy":
        if not settings.comfy_url or not supported:
            return None
        target = int(spec.get("target") or SIZE_TARGET.get(size, 4096))
        base = str(spec.get("base") or "").upper()
        if base not in supported:
            # only a size Flow itself makes (its 2K stage already enlarges once, so a 2K that ComfyUI takes over is no base) and never native 4K
            smaller = [z for z in ("1K", "2K") if z in supported and SIZE_TARGET[z] < target
                       and (settings.resolutions.get(z) or {"route": "flow"}).get("route", "flow") == "flow"]
            base = smaller[-1] if smaller else supported[0]
        return base, target, str(spec.get("engine") or settings.comfy_engine)
    return (size, None, "") if size in supported else None


def upscale_options(settings: Settings) -> list[dict]:
    """The enlarge steps the canvas button can offer: every resolution whose source is a ComfyUI enlarge."""
    if not settings.comfy_url:
        return []
    out = []
    for size in SIZE_ORDER:
        spec = settings.resolutions.get(size) or {}
        if spec.get("route") == "comfy" and size not in settings.disabled_sizes:
            out.append({"size": size, "target": int(spec.get("target") or SIZE_TARGET[size]),
                        "engine": str(spec.get("engine") or settings.comfy_engine)})
    return out or [{"size": "4K", "target": SIZE_TARGET["4K"], "engine": settings.comfy_engine}]


def upscale_info(settings: Settings) -> dict:
    return {"enabled": bool(settings.comfy_url), "options": upscale_options(settings)}


CLOUD_PROVIDERS = ("xyq", "libtv", "lovart")      # sources that make video too (and whose credits the top bar shows)
SOURCE_NAMES = {"flow": "Flow", "chatgpt": "ChatGPT", "xyq": "小云雀", "libtv": "LibTV", "lovart": "Lovart"}
DEFAULT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"]
REF_LIMITS = {"flow": 14, "chatgpt": 8}   # most reference pictures a source takes (the rest take 9)


def mentions_to_ordinals(prompt: str, n_refs: int) -> str:
    """<Picture N> -> "第N张图"; a tag outside the list is dropped."""
    return PICTURE_TAG_RE.sub(lambda m: f"第{m.group(1)}张图" if 1 <= int(m.group(1)) <= n_refs else "", prompt)


FREE_PROVIDERS = ("flow", "chatgpt")   # no credits are spent on these (Flow: the shared flow2api account; ChatGPT: its own quota)


def combo_is_free(m: dict, size: str, quality: str = "") -> bool:
    """May a user without credit-model access pick this size + quality on this gateway model?
    Free = 0 credits: the model is a free source, or the price table says 0 (zero), or the unlimited-slow mode covers it (slow; a
    condition beyond the size, e.g. "low" quality, has to be matched by the chosen quality)."""
    if m.get("provider") in FREE_PROVIDERS:
        return True
    free, s, q = m.get("free") or {}, str(size).lower(), (quality or "").lower()
    zero = free.get("zero") or []
    if q == "" and any(z == "*" or str(z).lower() == s for z in zero):
        return True
    slow = free.get("slow")
    if slow and any(z == "*" or str(z).lower() == s for z in slow.get("res") or []):
        extra = [str(x).lower() for x in slow.get("extra") or []]
        return all(x == q for x in extra) if extra else q == ""
    return False
