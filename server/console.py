"""Desktop control panel: runs the web service in-process and shows usage, server state, users, running tasks and the log.

    python -m server.console        (start.bat does this)
    python -m server.main           (headless, plain uvicorn log)
"""
from __future__ import annotations

import dataclasses
import logging
import logging.handlers
import queue
import re
import sqlite3
import threading
import time
import tkinter as tk
import webbrowser
from datetime import datetime
from tkinter import messagebox, ttk

import customtkinter as ctk
import httpx
import uvicorn

from .app import create_app
from . import cleanup
from .comfy_workflows import UPSCALERS
from .config import ROOT, SIZE_ORDER, Settings, load_settings

BG, CARD, EDGE = "#242424", "#2d2d2d", "#3a3a3a"
TEXT, DIM = "#e6e6e6", "#8d8d8d"
OK, WARN, BAD, ACCENT = "#5fd38d", "#e6b84f", "#ef6a6a", "#7aa7ff"

LOG_LIMIT = 1500
NOISE = re.compile(r'"(GET|PUT|HEAD) /api/(usage|jobs|boards|assets|me|models|users|health)[^"]*" 200')


class ServerThread:
    """uvicorn in a background thread that can be stopped and started again."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.server: uvicorn.Server | None = None
        self.thread: threading.Thread | None = None
        self.started = 0.0
        self.error = ""

    @property
    def running(self) -> bool:
        return bool(self.thread and self.thread.is_alive() and self.server and self.server.started)

    @property
    def alive(self) -> bool:
        return bool(self.thread and self.thread.is_alive())

    def start(self) -> None:
        if self.alive:
            return
        self.error = ""
        s = self.settings
        cfg = uvicorn.Config(create_app(s), host=s.host, port=s.port, log_config=None, log_level="info")
        self.server = uvicorn.Server(cfg)
        self.server.install_signal_handlers = lambda: None  # only the main thread may own signals

        def run() -> None:
            try:
                self.started = time.time()
                self.server.run()  # type: ignore[union-attr]
            except BaseException as exc:  # port in use etc.
                self.error = f"{type(exc).__name__}: {exc}"
                logging.getLogger("uvicorn.error").error("服务启动失败：%s", self.error)

        self.thread = threading.Thread(target=run, name="uvicorn", daemon=True)
        self.thread.start()

    def stop(self, timeout: float = 15.0) -> None:
        if self.server:
            self.server.should_exit = True
        if self.thread:
            self.thread.join(timeout)


def setup_logging(q: "queue.Queue[tuple[int, str]]") -> None:
    class ToQueue(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            try:
                q.put((record.levelno, self.format(record)))
            except Exception:
                pass

    fmt = logging.Formatter("%(asctime)s  %(levelname)-7s %(message)s", "%H:%M:%S")
    (ROOT / "logs").mkdir(exist_ok=True)
    file = logging.handlers.RotatingFileHandler(ROOT / "logs" / "server.log", maxBytes=5_000_000, backupCount=3, encoding="utf-8")
    file.setFormatter(fmt)
    live = ToQueue()
    live.setFormatter(fmt)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "server"):
        lg = logging.getLogger(name)
        lg.handlers = [file, live]
        lg.setLevel(logging.INFO)
        lg.propagate = False


def fmt_duration(sec: float) -> str:
    sec = int(max(0, sec))
    h, r = divmod(sec, 3600)
    m, s = divmod(r, 60)
    return f"{h}小时{m:02d}分" if h else f"{m}分{s:02d}秒" if m else f"{s}秒"


class Stat(ctk.CTkFrame):
    def __init__(self, master, title: str):
        super().__init__(master, fg_color=CARD, corner_radius=10, border_width=1, border_color=EDGE)
        ctk.CTkLabel(self, text=title, text_color=DIM, font=("Microsoft YaHei UI", 12)).pack(anchor="w", padx=14, pady=(10, 0))
        self.value = ctk.CTkLabel(self, text="–", text_color=TEXT, font=("Microsoft YaHei UI", 24, "bold"))
        self.value.pack(anchor="w", padx=14)
        self.sub = ctk.CTkLabel(self, text="", text_color=DIM, font=("Microsoft YaHei UI", 11))
        self.sub.pack(anchor="w", padx=14, pady=(0, 10))

    def set(self, value: str, sub: str = "", color: str = TEXT) -> None:
        self.value.configure(text=value, text_color=color)
        self.sub.configure(text=sub)


class Console:
    def __init__(self) -> None:
        self.settings = load_settings()
        self.logq: "queue.Queue[tuple[int, str]]" = queue.Queue()
        setup_logging(self.logq)
        self.server = ServerThread(self.settings)
        self.flow: dict = {"usage": None, "health": None, "error": ""}
        ctk.set_appearance_mode("Dark")
        self.root = ctk.CTk(fg_color=BG)
        self.hide_noise = tk.BooleanVar(value=True)
        self.root.title("Terry Flow 控制台")
        self.root.geometry("1080x760")
        self.root.minsize(900, 600)
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.build()
        self.server.start()
        threading.Thread(target=self.flow_loop, daemon=True).start()
        self.root.after(200, self.pump_log)
        self.root.after(300, self.refresh)

    # ---- layout
    def build(self) -> None:
        r = self.root
        r.grid_columnconfigure(0, weight=1)
        r.grid_rowconfigure(2, weight=3)
        r.grid_rowconfigure(3, weight=2)

        top = ctk.CTkFrame(r, fg_color="transparent")
        top.grid(row=0, column=0, sticky="ew", padx=16, pady=(14, 8))
        ctk.CTkLabel(top, text="Terry Flow", font=("Microsoft YaHei UI", 20, "bold"), text_color=TEXT).pack(side="left")
        for text, cmd in (("设置", self.open_settings), ("清理图片", self.clean_assets), ("清空日志", self.clear_log), ("重启服务", self.restart), ("打开网页", self.open_web)):
            ctk.CTkButton(top, text=text, width=84, height=30, fg_color=CARD, hover_color=EDGE, border_width=1, border_color=EDGE,
                          text_color=TEXT, command=cmd).pack(side="right", padx=(8, 0))

        cards = ctk.CTkFrame(r, fg_color="transparent")
        cards.grid(row=1, column=0, sticky="ew", padx=16)
        self.stats = {k: Stat(cards, t) for k, t in (("server", "服务器"), ("flow", "Flow 后端"), ("credits", "剩余额度"),
                                                     ("today", "今日生成"), ("jobs", "进行中的任务"))}
        for i, s in enumerate(self.stats.values()):
            cards.grid_columnconfigure(i, weight=1, uniform="c")
            s.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else 8, 0))

        mid = ctk.CTkFrame(r, fg_color="transparent")
        mid.grid(row=2, column=0, sticky="nsew", padx=16, pady=(12, 0))
        mid.grid_columnconfigure(0, weight=5, uniform="m")
        mid.grid_columnconfigure(1, weight=6, uniform="m")
        mid.grid_rowconfigure(0, weight=1)
        self.style_tree()
        self.users = self.table(mid, 0, "用户", [("name", "用户", 120, "w"), ("boards", "画板", 52, "center"),
                                                  ("today", "今日", 52, "center"), ("total", "累计", 60, "center"),
                                                  ("state", "状态", 90, "center")])
        self.tasks = self.table(mid, 1, "正在运行的任务", [("user", "用户", 90, "w"), ("model", "模型", 150, "w"),
                                                        ("state", "状态", 90, "w"), ("time", "已用", 70, "center"),
                                                        ("prompt", "提示词", 200, "w")])

        box = ctk.CTkFrame(r, fg_color=CARD, corner_radius=10, border_width=1, border_color=EDGE)
        box.grid(row=3, column=0, sticky="nsew", padx=16, pady=(12, 16))
        box.grid_columnconfigure(0, weight=1)
        box.grid_rowconfigure(1, weight=1)
        head = ctk.CTkFrame(box, fg_color="transparent")
        head.grid(row=0, column=0, sticky="ew", padx=12, pady=(8, 0))
        ctk.CTkLabel(head, text="日志", text_color=TEXT, font=("Microsoft YaHei UI", 13, "bold")).pack(side="left")
        ctk.CTkSwitch(head, text="隐藏常规请求", variable=self.hide_noise, text_color=DIM, font=("Microsoft YaHei UI", 12),
                      progress_color=ACCENT).pack(side="right")
        self.log = ctk.CTkTextbox(box, fg_color="#1b1b1b", text_color=TEXT, font=("Consolas", 12), wrap="none", corner_radius=6)
        self.log.grid(row=1, column=0, sticky="nsew", padx=10, pady=10)
        t = self.log._textbox  # colour tags need the underlying tk widget
        t.tag_config("warn", foreground=WARN)
        t.tag_config("err", foreground=BAD)
        t.tag_config("dim", foreground=DIM)
        t.tag_config("ok", foreground=OK)
        self.log.configure(state="disabled")

    def style_tree(self) -> None:
        st = ttk.Style()
        st.theme_use("clam")
        st.configure("T.Treeview", background=CARD, fieldbackground=CARD, foreground=TEXT, borderwidth=0, rowheight=28,
                     font=("Microsoft YaHei UI", 10))
        st.configure("T.Treeview.Heading", background=EDGE, foreground=DIM, borderwidth=0, relief="flat",
                     font=("Microsoft YaHei UI", 10))
        st.map("T.Treeview", background=[("selected", "#3d4b66")], foreground=[("selected", TEXT)])
        st.map("T.Treeview.Heading", background=[("active", EDGE)])
        st.layout("T.Treeview", [("Treeview.treearea", {"sticky": "nswe"})])

    def table(self, master, col: int, title: str, cols: list) -> ttk.Treeview:
        f = ctk.CTkFrame(master, fg_color=CARD, corner_radius=10, border_width=1, border_color=EDGE)
        f.grid(row=0, column=col, sticky="nsew", padx=(0 if col == 0 else 8, 0))
        f.grid_columnconfigure(0, weight=1)
        f.grid_rowconfigure(1, weight=1)
        ctk.CTkLabel(f, text=title, text_color=TEXT, font=("Microsoft YaHei UI", 13, "bold")).grid(row=0, column=0, sticky="w", padx=12, pady=(8, 4))
        tv = ttk.Treeview(f, style="T.Treeview", columns=[c[0] for c in cols], show="headings", selectmode="none")
        for key, text, w, anchor in cols:
            tv.heading(key, text=text, anchor=anchor)
            tv.column(key, width=w, anchor=anchor, stretch=key in ("name", "user", "prompt", "model"))
        tv.tag_configure("busy", foreground=ACCENT)
        tv.tag_configure("wait", foreground=WARN)
        sb = ctk.CTkScrollbar(f, command=tv.yview, fg_color=CARD)
        tv.configure(yscrollcommand=sb.set)
        tv.grid(row=1, column=0, sticky="nsew", padx=(8, 0), pady=(0, 8))
        sb.grid(row=1, column=1, sticky="ns", padx=(0, 4), pady=(0, 8))
        return tv

    # ---- actions
    def open_web(self) -> None:
        webbrowser.open(f"http://127.0.0.1:{self.settings.port}/")

    def clear_log(self) -> None:
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")

    # ---- settings (ComfyUI address, enlarge method, where each resolution comes from)
    ROUTES = {"Flow 原生": "flow", "ComfyUI 放大": "comfy", "关闭": "off"}

    def open_settings(self) -> None:
        win = ctk.CTkToplevel(self.root, fg_color=BG)
        win.title("服务器设置")
        win.geometry("640x640")
        win.transient(self.root)
        win.after(150, win.focus)
        cfg_path = ROOT / "config.json"
        import json
        raw = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
        cf = raw.get("comfyui") or {}
        s = self.settings
        label = lambda parent, text, **kw: ctk.CTkLabel(parent, text=text, text_color=kw.pop("color", TEXT),
                                                        font=("Microsoft YaHei UI", kw.pop("size", 13)), **kw)
        box = ctk.CTkFrame(win, fg_color=CARD, corner_radius=10, border_width=1, border_color=EDGE)
        box.pack(fill="x", padx=16, pady=(16, 8))
        label(box, "ComfyUI（放大与以后的编辑、生图、视频、文本增强）", size=14).grid(row=0, column=0, columnspan=3, sticky="w", padx=14, pady=(12, 6))
        label(box, "地址").grid(row=1, column=0, sticky="w", padx=14, pady=6)
        url = ctk.CTkEntry(box, width=300, placeholder_text="http://127.0.0.1:8188（留空 = 不启用）")
        url.insert(0, s.comfy_url)
        url.grid(row=1, column=1, sticky="w", pady=6)
        status = label(box, "", color=DIM, size=12)
        status.grid(row=2, column=1, columnspan=2, sticky="w", pady=(0, 4))

        def test() -> None:
            status.configure(text="连接中…", text_color=DIM)
            target = url.get().strip().rstrip("/")

            def work() -> None:
                try:
                    with httpx.Client(timeout=6) as c:
                        r = c.get(target + "/system_stats")
                        r.raise_for_status()
                        v = r.json().get("system", {}).get("comfyui_version", "?")
                    msg, col = f"连接成功（ComfyUI {v}）", OK
                except Exception as exc:
                    msg, col = f"连接失败：{type(exc).__name__}", BAD
                win.after(0, lambda: status.configure(text=msg, text_color=col))

            threading.Thread(target=work, daemon=True).start()

        ctk.CTkButton(box, text="测试连接", width=84, height=28, fg_color=EDGE, hover_color="#4a4a4a", command=test).grid(row=1, column=2, padx=10)
        label(box, "放大方案").grid(row=3, column=0, sticky="w", padx=14, pady=(6, 12))
        names = {key: text for key, (text, _f) in UPSCALERS.items()}
        engine = ctk.CTkOptionMenu(box, values=list(names.values()), width=300, fg_color=EDGE, button_color=EDGE)
        engine.set(names.get(s.comfy_engine, names["seedvr2"]))
        engine.grid(row=3, column=1, sticky="w", pady=(6, 12))

        rbox = ctk.CTkFrame(win, fg_color=CARD, corner_radius=10, border_width=1, border_color=EDGE)
        rbox.pack(fill="x", padx=16, pady=8)
        label(rbox, "分辨率从哪里来", size=14).grid(row=0, column=0, columnspan=4, sticky="w", padx=14, pady=(12, 2))
        label(rbox, "选“ComfyUI 放大”：先让 Flow 按“基础尺寸”出图，再放大到“目标长边”像素。", color=DIM, size=12).grid(
            row=1, column=0, columnspan=4, sticky="w", padx=14, pady=(0, 6))
        for j, head in enumerate(("分辨率", "来源", "基础尺寸", "目标长边（像素）")):
            label(rbox, head, color=DIM, size=12).grid(row=2, column=j, sticky="w", padx=(14 if j == 0 else 4, 4))
        rows = {}
        back = {v: k for k, v in self.ROUTES.items()}
        for i, size in enumerate(SIZE_ORDER):
            spec = s.resolutions.get(size, {})
            label(rbox, size).grid(row=3 + i, column=0, sticky="w", padx=14, pady=5)
            route = ctk.CTkOptionMenu(rbox, values=list(self.ROUTES), width=130, fg_color=EDGE, button_color=EDGE)
            route.set(back.get(spec.get("route", "flow"), "Flow 原生"))
            route.grid(row=3 + i, column=1, sticky="w", padx=4)
            base = ctk.CTkOptionMenu(rbox, values=["1K", "2K"], width=80, fg_color=EDGE, button_color=EDGE)
            base.set(str(spec.get("base", "2K")))
            base.grid(row=3 + i, column=2, sticky="w", padx=4)
            target = ctk.CTkEntry(rbox, width=100)
            target.insert(0, str(spec.get("target", {"4K": 4096, "6K": 6144}.get(size, ""))))
            target.grid(row=3 + i, column=3, sticky="w", padx=4)
            rows[size] = (route, base, target)
        label(rbox, "", size=4).grid(row=8, column=0)
        label(win, "模型文件名等高级项在 config.json 的 comfyui 里改。保存后立即生效，无需重启。", color=DIM, size=12).pack(anchor="w", padx=18, pady=(4, 0))

        def save() -> None:
            res: dict = {}
            for size, (route, base, target) in rows.items():
                kind = self.ROUTES[route.get()]
                spec: dict = {"route": kind}
                if kind == "comfy":
                    try:
                        spec.update(base=base.get(), target=int(target.get()))
                    except ValueError:
                        messagebox.showerror("设置", f"{size} 的目标长边需要是数字", parent=win)
                        return
                res[size] = spec
            comfy = dict(cf)
            comfy["url"] = url.get().strip().rstrip("/")
            comfy["upscale_engine"] = next((k for k, t in names.items() if t == engine.get()), "seedvr2")
            raw["comfyui"] = comfy
            raw["resolutions"] = res
            raw.pop("disabled_sizes", None)   # superseded by the "关闭" route
            cfg_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
            new = load_settings()
            for f in dataclasses.fields(Settings):
                if f.name not in ("host", "port", "data_dir"):
                    setattr(self.settings, f.name, getattr(new, f.name))
            logging.getLogger("uvicorn.error").info("服务器设置已保存")
            win.destroy()

        bar = ctk.CTkFrame(win, fg_color="transparent")
        bar.pack(side="bottom", fill="x", padx=16, pady=14)
        ctk.CTkButton(bar, text="保存", width=90, fg_color=ACCENT, text_color="#101418", hover_color="#9bbcff", command=save).pack(side="right")
        ctk.CTkButton(bar, text="取消", width=90, fg_color=CARD, hover_color=EDGE, border_width=1, border_color=EDGE, text_color=TEXT,
                      command=win.destroy).pack(side="right", padx=8)

    def clean_assets(self) -> None:
        dlg = ctk.CTkInputDialog(text="清理多少天前、没有被任何画板、头像或进行中任务使用的图片？\n（单位：天，最短 1 天）", title="清理未使用的图片")
        raw = (dlg.get_input() or "").strip()
        if not raw:
            return
        try:
            days = max(1.0, float(raw))
        except ValueError:
            messagebox.showerror("清理", "请输入数字（天数）")
            return
        res = cleanup.scan(self.settings, days)
        mb = res.bytes / 1048576
        if not res.ids:
            messagebox.showinfo("清理", f"没有可清理的图片。\n图片共 {res.total_files} 张，其中 {res.kept_young} 张未被使用但不足 {days:g} 天。")
            return
        if not messagebox.askyesno("清理", f"找到 {len(res.ids)} 张未使用的图片（共 {mb:.1f} MB），都已超过 {days:g} 天。\n"
                                         f"删除后无法恢复，确定删除吗？"):
            return
        n, freed = cleanup.delete(self.settings, res.ids)
        logging.getLogger("uvicorn.error").info("清理未使用图片：删除 %d 张，释放 %.1f MB", n, freed / 1048576)
        messagebox.showinfo("清理", f"已删除 {n} 张，释放 {freed / 1048576:.1f} MB。")

    def restart(self) -> None:
        if not messagebox.askyesno("重启服务", "重启会中断正在进行的请求，确定吗？"):
            return
        logging.getLogger("uvicorn.error").info("—— 重启服务 ——")
        self.root.config(cursor="watch")

        def work() -> None:
            self.server.stop()
            self.settings = load_settings()
            self.server = ServerThread(self.settings)
            self.server.start()
            self.root.after(0, lambda: self.root.config(cursor=""))

        threading.Thread(target=work, daemon=True).start()

    def close(self) -> None:
        if not messagebox.askyesno("退出", "退出控制台会同时停止服务，局域网里的用户将无法使用。确定退出吗？"):
            return
        self.server.stop(8)
        self.root.destroy()

    # ---- data
    def flow_loop(self) -> None:
        s = self.settings
        headers = {"Authorization": f"Bearer {s.flow_api_key}"}
        while True:
            try:
                s = self.settings
                headers = {"Authorization": f"Bearer {s.flow_api_key}"}
                with httpx.Client(timeout=8) as c:
                    h = c.get(s.flow_base_url + "/health")
                    h.raise_for_status()
                    u = c.get(s.flow_base_url + "/v1/usage", headers=headers)
                    u.raise_for_status()
                    self.flow = {"usage": u.json(), "health": h.json(), "error": ""}
            except Exception as exc:
                self.flow = {"usage": None, "health": None, "error": type(exc).__name__}
            time.sleep(10)

    def query(self) -> tuple[list, list]:
        midnight = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        db = sqlite3.connect(f"file:{self.settings.db_path.as_posix()}?mode=ro", uri=True, timeout=3)
        db.row_factory = sqlite3.Row
        try:
            users = db.execute(
                "SELECT u.name, "
                " (SELECT COUNT(*) FROM boards b WHERE b.user=u.id) AS boards,"
                " (SELECT COUNT(*) FROM jobs j WHERE j.user=u.id AND j.status='done' AND j.finished>=?) AS today,"
                " (SELECT COUNT(*) FROM jobs j WHERE j.user=u.id AND j.status='done') AS total,"
                " (SELECT COUNT(*) FROM jobs j WHERE j.user=u.id AND j.status='running') AS running,"
                " (SELECT COUNT(*) FROM jobs j WHERE j.user=u.id AND j.status='queued') AS queued "
                "FROM users u ORDER BY running DESC, queued DESC, today DESC, u.name", (midnight,)).fetchall()
            tasks = db.execute(
                "SELECT COALESCE(u.name,'?') AS user, j.model, j.status, j.progress, j.created, j.started, j.prompt "
                "FROM jobs j LEFT JOIN users u ON u.id=j.user WHERE j.status IN ('queued','running') ORDER BY j.created").fetchall()
            return users, tasks
        finally:
            db.close()

    def refresh(self) -> None:
        try:
            users, tasks = self.query()
        except Exception:
            users, tasks = [], []
        run = sum(1 for t in tasks if t["status"] == "running")
        wait = len(tasks) - run
        srv = self.server
        if srv.running:
            self.stats["server"].set("运行中", f"端口 {self.settings.port} · 已运行 {fmt_duration(time.time() - srv.started)}", OK)
        elif srv.error:
            self.stats["server"].set("启动失败", srv.error[:40], BAD)
        else:
            self.stats["server"].set("启动中…", f"端口 {self.settings.port}", WARN)

        fl = self.flow
        if fl["health"] is not None:
            h = fl["health"]
            ok = h.get("backend_running") and h.get("active_tokens", 0) > 0
            self.stats["flow"].set("正常" if ok else "异常", f"账号 {h.get('active_tokens', 0)}/{h.get('total_tokens', 0)} 可用 · 验证码 {h.get('captcha_method', '?')}",
                                   OK if ok else WARN)
        elif fl["error"]:
            self.stats["flow"].set("无法连接", fl["error"], BAD)
        u = fl["usage"]
        if u:
            self.stats["credits"].set(str(u.get("credits", "–")), "Flow 账号剩余点数")
            used = sum(int(d.get("used", 0)) for d in u.get("image_daily", []))
            detail = " · ".join(f"{'Pro' if d.get('key') == 'pro' else '其他'} {d.get('used')}/{d.get('limit')}" for d in u.get("image_daily", []))
            self.stats["today"].set(f"{used} 张", detail)
        self.stats["jobs"].set(str(len(tasks)), f"运行 {run} · 排队 {wait}", ACCENT if tasks else TEXT)

        self.fill(self.users, [((r["name"], r["boards"], r["today"], r["total"],
                                 f"生成中 {r['running']}" if r["running"] else f"排队 {r['queued']}" if r["queued"] else "空闲"),
                                ("busy",) if r["running"] else ("wait",) if r["queued"] else ()) for r in users])
        now = time.time()
        self.fill(self.tasks, [((t["user"], t["model"], "生成中" if t["status"] == "running" else "排队中",
                                 fmt_duration(now - (t["started"] or t["created"])), (t["prompt"] or "").replace("\n", " ")[:80]),
                                ("busy",) if t["status"] == "running" else ("wait",)) for t in tasks])
        self.root.after(2000, self.refresh)

    @staticmethod
    def fill(tv: ttk.Treeview, rows: list) -> None:
        tv.delete(*tv.get_children())
        for values, tags in rows:
            tv.insert("", "end", values=values, tags=tags)

    def pump_log(self) -> None:
        lines: list[tuple[int, str]] = []
        try:
            while len(lines) < 400:
                lines.append(self.logq.get_nowait())
        except queue.Empty:
            pass
        if lines:
            t = self.log._textbox
            at_bottom = t.yview()[1] > 0.98
            t.configure(state="normal")
            for level, text in lines:
                if self.hide_noise.get() and NOISE.search(text):
                    continue
                tag = "err" if level >= logging.ERROR or re.search(r'" (4\d\d|5\d\d) ', text) else "warn" if level >= logging.WARNING else ""
                t.insert("end", text + "\n", tag)
            extra = int(t.index("end-1c").split(".")[0]) - LOG_LIMIT
            if extra > 0:
                t.delete("1.0", f"{extra + 1}.0")
            t.configure(state="disabled")
            if at_bottom:
                t.see("end")
        self.root.after(150, self.pump_log)

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    Console().run()


if __name__ == "__main__":
    main()
