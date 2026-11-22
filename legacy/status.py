"""Turn flow2api status codes into the short messages this app shows (flow2api only sends code + params)."""
from __future__ import annotations

from typing import Any, Callable

Params = dict[str, Any]

# code -> short plain text (no icons; the UI decides how to decorate). Captcha / token details show as "生成中".
TEXT: dict[str, Callable[[Params], str]] = {
    "progress": lambda p: f"生成中 {p.get('percent', 0)}%",
    "task_started": lambda p: "已提交",
    "queued": lambda p: f"排队中 第 {p.get('position', '?')} 位",
    "init_env": lambda p: "准备中",
    "account_switch": lambda p: "换账号重试",
    "refs_uploading": lambda p: "上传参考图",
    "ref_uploaded": lambda p: f"参考图 {p.get('index', '')}/{p.get('total', '')}",
    "frames_uploading": lambda p: "上传首尾帧" if p.get("last") else "上传首帧",
    "captcha_after_upload": lambda p: "生成中",
    "captcha_submit": lambda p: "生成中",
    "upscale_start": lambda p: f"放大到 {p.get('resolution', '')}",
    "upscale_done": lambda p: "放大完成",
    "upscale_retry": lambda p: f"放大重试 {p.get('attempt', '')}/{p.get('max', '')}",
    "upscale_failed": lambda p: "放大失败",
    "upscale_polling": lambda p: "放大中",
    "cache_start": lambda p: "保存中",
    "cache_done": lambda p: "已保存",
    "cache_failed": lambda p: "保存失败",
    "cache_disabled": lambda p: "",
    "images_ignored": lambda p: "已忽略参考图",
    "video_submit": lambda p: "提交视频",
    "video_extend_submit": lambda p: "提交续写",
    "video_generating": lambda p: "生成中",
    "video_downloading": lambda p: "下载视频",
    "video_extend_done": lambda p: "续写完成",
}


def format_status(code: str, params: Params | None) -> tuple[str, str]:
    """Return ``(kind, text)``; kind is ``error`` or ``progress`` (empty text = nothing to show)."""
    params = params or {}
    if code == "error":
        return "error", str(params.get("message") or "生成失败")
    if code == "message":  # a line flow2api could not classify
        return "progress", str(params.get("text") or "")
    fmt = TEXT.get(code)
    return "progress", fmt(params) if fmt else "处理中…"
