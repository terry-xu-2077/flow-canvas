"""Turn flow2api status codes into the short messages this app shows (flow2api only sends code + params)."""
from __future__ import annotations

from typing import Any, Callable

Params = dict[str, Any]

# code -> text. Captcha / token details are deliberately shown as plain "generating".
TEXT: dict[str, Callable[[Params], str]] = {
    "progress": lambda p: f"生成中 约 {p.get('percent', 0)}%",
    "task_started": lambda p: "任务已启动",
    "queued": lambda p: f"排队中：您排在第 {p.get('position', '?')} 位（{p.get('active', '?')} 个任务正在生成）",
    "init_env": lambda p: "准备中…",
    "account_switch": lambda p: "账号额度用尽，正在换账号重试…" if p.get("reason") == "quota" else "账号触发风控，正在换账号重试…",
    "refs_uploading": lambda p: f"上传 {p.get('count', '')} 张参考图…",
    "ref_uploaded": lambda p: f"已上传 {p.get('index', '')}/{p.get('total', '')} 张参考图",
    "frames_uploading": lambda p: "上传首尾帧…" if p.get("last") else "上传首帧…",
    "captcha_after_upload": lambda p: "正在生成中…",
    "captcha_submit": lambda p: "正在生成中…",
    "upscale_start": lambda p: f"放大到 {p.get('resolution', '')}…",
    "upscale_done": lambda p: f"已放大到 {p.get('resolution', '')}",
    "upscale_retry": lambda p: f"放大遇到{p.get('reason', '问题')}，重试 {p.get('attempt', '')}/{p.get('max', '')}…",
    "upscale_failed": lambda p: "放大失败，使用原图",
    "upscale_polling": lambda p: "放大处理中…",
    "cache_start": lambda p: "保存结果…",
    "cache_done": lambda p: "结果已保存",
    "cache_failed": lambda p: "保存结果失败，使用源链接",
    "cache_disabled": lambda p: "返回源链接…",
    "images_ignored": lambda p: "该模型不支持参考图，已忽略",
    "video_submit": lambda p: "提交视频任务…",
    "video_extend_submit": lambda p: "提交视频续写任务…",
    "video_generating": lambda p: "视频生成中…",
    "video_downloading": lambda p: "下载视频…",
    "video_extend_done": lambda p: "续写片段已生成",
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
