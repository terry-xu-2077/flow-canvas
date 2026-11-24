"""A stand-in for the terry2api aggregation API: models, credits, media, generation tasks, result files."""
import hashlib
import io
import json
import time

import httpx
from PIL import Image

GATEWAY = "http://gateway.test"


def png(color=(200, 30, 30), size=(64, 48)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def wait_job(client, job_id, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get("/api/jobs", params={"ids": job_id}).json()["jobs"][0]
        if job["status"] in ("done", "failed", "cancelled"):
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


RESULT_PNG = png((9, 99, 199), (64, 48))
VIDEO = b"\x00\x00\x00\x18ftypmp42" + b"v" * 500

FLOW = {"id": "flow:Nano Banana 2.1", "provider": "flow", "kind": "image", "name": "Nano Banana 2.1", "key": "gemini-3.1-flash-image",
        "info": {"ratios": ["16:9", "9:16", "1:1"], "resolutions": ["1K", "2K"]}}
GPT = {"id": "chatgpt:GPT Image", "provider": "chatgpt", "kind": "image", "name": "GPT Image", "key": "gpt-image",
       "info": {"ratios": ["1:1", "3:2", "2:3", "16:9", "9:16"], "resolutions": []}}
XYQ_IMG = {"id": "xyq:Img One", "provider": "xyq", "kind": "image", "name": "Img One", "key": "k",
           "info": {"ratios": ["16:9", "1:1", "adaptive"], "resolutions": ["1k", "2k"]}, "free": {"zero": ["1k"]}, "qualities": ["low", "high"]}
LOVART_IMG = {"id": "lovart:openai/gpt-image-2", "provider": "lovart", "kind": "image", "name": "GPT Image 2", "key": "k",
              "free": {"slow": {"days": 9, "condition": "low 1K", "res": ["1K"], "extra": ["low"]}}, "qualities": ["low", "medium", "high"]}
XYQ_VID = {"id": "xyq:Seedance 2.0", "provider": "xyq", "kind": "video", "name": "Seedance 2.0", "key": "k1",
           "info": {"ratios": ["16:9", "9:16"], "resolutions": ["720p"], "durations": {"options": [5, 10]}, "sound": False}}
LIBTV_VID = {"id": "libtv:Kling", "provider": "libtv", "kind": "video", "name": "Kling", "key": "k2", "vip": True}


class FakeGateway:
    def __init__(self):
        self.submitted: list[dict] = []
        self.kinds: dict[str, str] = {}
        self.polls: dict[str, int] = {}
        self.hold = False                 # tasks stay "running"
        self.fail_with: str | None = None
        self.cancelled: list[str] = []
        self.quotes: list[dict] = []
        self.media: dict[str, bytes] = {}
        self.usable = {"flow": True, "chatgpt": True, "xyq": True, "libtv": True, "lovart": True}

    def models(self, kind: str) -> list[dict]:
        pool = [FLOW, GPT, XYQ_IMG, LOVART_IMG] if kind == "image" else [XYQ_VID, LIBTV_VID]
        return [m for m in pool if self.usable.get(m["provider"])]

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/models":
            return httpx.Response(200, json={"models": self.models(request.url.params.get("kind", "image")), "errors": {}})
        if path == "/v1/providers":
            return httpx.Response(200, json={"providers": [{"id": k, "usable": v, "configured": v} for k, v in self.usable.items()]})
        if path == "/v1/model_info":
            return httpx.Response(200, json={"ratios": ["16:9"], "resolutions": [], "durations": None, "sound": True})
        if path == "/v1/credits":
            return httpx.Response(200, json={"items": [i for i in [
                {"provider": "flow", "ok": True, "balance": 250, "image_daily": [{"name": "Nano Banana 2.1 / Pro", "used": 3, "limit": 1000}]},
                {"provider": "chatgpt", "ok": True, "balance": None, "quota": {"hour": {"limit": 35, "used": 2}, "day": {"limit": 120, "used": 9}}},
                {"provider": "xyq", "ok": True, "balance": 1272},
                {"provider": "libtv", "ok": True, "balance": 13986, "detail": {"会员": "VIP"}, "raw": "x"}] if self.usable.get(i["provider"])],
                "extension": {"connected": True}})
        if path == "/v1/prices/quote":
            self.quotes.append(dict(request.url.params))
            return httpx.Response(200, json={"amount": 135, "unit": "5 秒", "unlimited": None})
        if path == "/v1/media" and request.method == "POST":
            mid = "m_" + hashlib.sha1(request.content).hexdigest()[:32]
            self.media[mid] = request.content
            return httpx.Response(200, json={"id": mid})
        if path.startswith("/v1/media/"):
            return httpx.Response(200 if path.rsplit("/", 1)[1] in self.media else 404)
        if path in ("/v1/image/generations", "/v1/video/generations"):
            body = json.loads(request.content)
            self.submitted.append(body)
            tid = f"t{len(self.submitted)}"
            self.kinds[tid] = "image" if "image" in path else "video"
            return httpx.Response(200, json={"id": tid, "status": "queued"})
        if path.startswith("/v1/tasks/") and path.endswith("/cancel"):
            self.cancelled.append(path.split("/")[3])
            return httpx.Response(200, json={"cancelled": True})
        if path.startswith("/v1/tasks/"):
            tid = path.rsplit("/", 1)[1]
            self.polls[tid] = self.polls.get(tid, 0) + 1
            if self.fail_with:
                return httpx.Response(200, json={"id": tid, "status": "failed", "error": self.fail_with})
            if self.hold or self.polls[tid] < 2:
                return httpx.Response(200, json={"id": tid, "status": "running", "progress": "生成中 0:03", "percent": 40})
            if self.kinds.get(tid) == "image":
                return httpx.Response(200, json={"id": tid, "status": "done", "outputs": [
                    {"file": f"{tid}_1.png", "url": f"/v1/files/{tid}_1.png", "type": "image"}]})
            return httpx.Response(200, json={"id": tid, "status": "done", "info": {"cost": 8}, "outputs": [
                {"file": f"{tid}_1.mp4", "url": f"/v1/files/{tid}_1.mp4", "type": "video"}]})
        if path.startswith("/v1/files/"):
            return httpx.Response(200, content=RESULT_PNG if path.endswith(".png") else VIDEO)
        return httpx.Response(404, json={"error": "nope"})


def make_app(tmp_path, fake=None, **settings_kw):
    """(app, fake gateway) with a canvas app whose aggregation API is the fake."""
    from server.app import create_app
    from server.config import Settings
    from server.gateway import GatewayClient
    fake = fake or FakeGateway()
    settings = Settings(data_dir=tmp_path / "data", gateway_url=GATEWAY, gateway_timeout=20, **settings_kw)
    app = create_app(settings, GatewayClient(GATEWAY, "", transport=httpx.MockTransport(fake.handle)))
    app.state.runner.poll_interval = 0.05
    return app, fake


def paid_user(app, client, name: str = "a", paid: bool = True) -> str:
    """Create a user; users start without access to the credit-costing models, so most tests switch it on."""
    uid = client.post("/api/users", json={"name": name}).json()["id"]
    if paid:
        app.state.store.set_user_paid(uid, True)
    return uid
