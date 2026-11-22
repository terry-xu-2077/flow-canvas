"""The video generation card: jobs go to the terry2api service and the finished file is stored as an asset."""
import base64
import hashlib
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.cloud import CloudClient
from server.config import Settings
from server.flow import FlowClient
from server.gpt import GptClient
from test_api import BASE, FakeFlow, png, wait_job

CLOUD = "http://cloud.test"
PNG = png((9, 99, 199), (64, 48))
VIDEO = b"\x00\x00\x00\x18ftypmp42" + b"v" * 500


class FakeCloud:
    def __init__(self):
        self.submitted: list[dict] = []
        self.polls = 0
        self.fail_with: str | None = None
        self.cancelled: list[str] = []
        self.quotes: list[dict] = []
        self.image_tasks: set[str] = set()
        self.lovart_on = True
        self.media: dict[str, bytes] = {}

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/models" and request.url.params.get("kind") == "image":
            return httpx.Response(200, json={"models": [
                {"id": "xyq:Img One", "provider": "xyq", "kind": "image", "name": "Img One", "key": "k",
                 "info": {"ratios": ["16:9", "1:1", "adaptive"], "resolutions": ["1k", "2k"]}},
                {"id": "lovart:openai/gpt-image-2", "provider": "lovart", "kind": "image", "name": "GPT Image 2", "key": "k"}], "errors": {}})
        if path == "/v1/image/generations":
            body = json.loads(request.content)
            self.submitted.append(body)
            self.image_tasks.add(f"t{len(self.submitted)}")
            return httpx.Response(200, json={"id": f"t{len(self.submitted)}", "status": "queued"})
        if path.startswith("/v1/files/") and path.endswith(".png"):
            return httpx.Response(200, content=PNG)
        if path == "/v1/models":
            return httpx.Response(200, json={"models": [
                {"id": "xyq:Seedance 2.0", "provider": "xyq", "kind": "video", "name": "Seedance 2.0", "key": "k1",
                 "info": {"ratios": ["16:9", "9:16"], "resolutions": ["720p"], "durations": {"options": [5, 10]}, "sound": False}},
                {"id": "libtv:Kling", "provider": "libtv", "kind": "video", "name": "Kling", "key": "k2", "vip": True}], "errors": {}})
        if path == "/v1/model_info":
            return httpx.Response(200, json={"ratios": ["16:9"], "resolutions": [], "durations": None, "sound": True})
        if path == "/v1/media" and request.method == "POST":
            mid = "m_" + hashlib.sha1(request.content).hexdigest()[:32]
            self.media[mid] = request.content
            return httpx.Response(200, json={"id": mid})
        if path.startswith("/v1/media/"):
            return httpx.Response(200 if path.rsplit("/", 1)[1] in self.media else 404)
        if path == "/v1/providers":
            return httpx.Response(200, json={"providers": [{"id": "xyq", "configured": True}, {"id": "libtv", "configured": True},
                                                           {"id": "lovart", "configured": self.lovart_on}]})
        if path == "/v1/prices/quote":
            self.quotes.append(dict(request.url.params))
            return httpx.Response(200, json={"amount": 135, "unit": "5 秒", "unlimited": None})
        if path == "/v1/balances":
            return httpx.Response(200, json={"items": [{"provider": "libtv", "name": "LibTV", "ok": True, "balance": 13986,
                                                        "source": "extension", "detail": {"会员": "VIP"}, "raw": "x"}],
                                             "extension": {"connected": True}})
        if path == "/v1/video/generations":
            body = json.loads(request.content)
            self.submitted.append(body)
            return httpx.Response(200, json={"id": f"t{len(self.submitted)}", "status": "queued"})
        if path.startswith("/v1/tasks/") and path.endswith("/cancel"):
            self.cancelled.append(path.split("/")[3])
            return httpx.Response(200, json={"cancelled": True})
        if path.startswith("/v1/tasks/"):
            self.polls += 1
            if self.fail_with:
                return httpx.Response(200, json={"id": "t1", "status": "failed", "error": self.fail_with})
            if self.polls < 2:
                return httpx.Response(200, json={"id": "t1", "status": "running", "progress": "生成中 0:03", "percent": 40})
            tid = path.rsplit("/", 1)[1]
            if tid in self.image_tasks:
                return httpx.Response(200, json={"id": tid, "status": "done", "outputs": [
                    {"file": f"{tid}_1.png", "url": f"/v1/files/{tid}_1.png", "type": "image"}]})
            return httpx.Response(200, json={"id": "t1", "status": "done", "info": {"cost": 8}, "outputs": [
                {"file": "t1_1.mp4", "url": "/v1/files/t1_1.mp4", "type": "video"}]})
        if path == "/v1/files/t1_1.mp4":
            return httpx.Response(200, content=VIDEO)
        return httpx.Response(404, json={"error": "nope"})


@pytest.fixture()
def env(tmp_path):
    fake, cloud = FakeFlow(), FakeCloud()
    settings = Settings(flow_base_url=BASE, flow_api_key="k", data_dir=tmp_path / "data", job_timeout=20,
                        cloud_base_url=CLOUD, cloud_timeout=20)
    flow = FlowClient(BASE, "k", transport=httpx.MockTransport(fake.handle), timeout=20)
    cc = CloudClient(CLOUD, "", transport=httpx.MockTransport(cloud.handle))
    app = create_app(settings, flow, GptClient("", ""), cc)
    app.state.runner.cloud_poll = 0.05
    with TestClient(app) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "小明"}).json()["id"]
        yield client, cloud


def upload(client, n: int = 0) -> str:
    return client.post("/api/assets", content=png((20 * n, 40, 90))).json()["id"]


def test_models_and_info(env):
    client, _ = env
    r = client.get("/api/video/models").json()
    assert r["enabled"] and [m["key"] for m in r["models"]] == ["xyq:Seedance 2.0", "libtv:Kling"]
    assert r["models"][0]["tag"] == "小云雀" and r["models"][1]["vip"] is True
    assert client.get("/api/video/model_info", params={"model": "libtv:Kling"}).json()["sound"] is True


def test_text_to_video_stores_asset(env):
    client, cloud = env
    ids = client.post("/api/video/jobs", json={"model": "xyq:Seedance 2.0", "prompt": "海边日落", "ratio": "16:9",
                                               "duration": 5}).json()["jobs"]
    job = wait_job(client, ids[0])
    assert job["status"] == "done", job
    assert job["kind"] == "video"
    body = cloud.submitted[0]
    assert body["provider"] == "xyq" and body["model"] == "Seedance 2.0" and body["duration"] == 5
    assert "first_frame" not in body and "ref_images" not in body
    got = client.get(f"/api/assets/{job['result_asset']}")
    assert got.status_code == 200 and got.content == VIDEO and got.headers["content-type"] == "video/mp4"
    assert client.get(f"/api/assets/{job['result_asset']}?w=256").content == VIDEO   # no thumbnail for videos
    assert client.get("/api/library").json()["generated"] == []                       # the image library skips videos


def test_frames_and_references(env):
    client, cloud = env
    a, b, c = upload(client, 1), upload(client, 2), upload(client, 3)
    mk = lambda **kw: client.post("/api/video/jobs", json={"model": "libtv:Kling", "prompt": "<Picture 1> 走向 <Picture 2>", **kw}).json()
    wait_job(client, mk(refs=[a])["jobs"][0])
    wait_job(client, mk(refs=[a, b])["jobs"][0])
    wait_job(client, mk(refs=[a, b, c])["jobs"][0])
    wait_job(client, mk(refs=[a, b], mode="reference")["jobs"][0])
    one, two, three, ref2 = cloud.submitted
    assert cloud.media[one["first_frame"]] == png((20, 40, 90)) and "last_frame" not in one
    assert "last_frame" in two and "<Picture" not in two["prompt"] and "第1张图" in two["prompt"]
    assert len(three["ref_images"]) == 3 and "<Picture 1>" in three["prompt"]
    assert len(ref2["ref_images"]) == 2 and "first_frame" not in ref2


def test_failure_is_reported(env):
    client, cloud = env
    cloud.fail_with = "积分不足"
    job = wait_job(client, client.post("/api/video/jobs", json={"model": "xyq:Seedance 2.0", "prompt": "x"}).json()["jobs"][0])
    assert job["status"] == "failed" and "积分不足" in job["error"]


def test_cancel_stops_remote_task(env):
    client, cloud = env
    cloud.polls = -10_000    # stays "running"
    jid = client.post("/api/video/jobs", json={"model": "xyq:Seedance 2.0", "prompt": "x"}).json()["jobs"][0]
    import time
    time.sleep(0.5)
    assert client.post(f"/api/jobs/{jid}/cancel").json()["cancelled"] is True
    job = wait_job(client, jid)
    assert job["status"] == "cancelled" and cloud.cancelled == ["t1"]


def test_validation(env):
    client, _ = env
    assert client.post("/api/video/jobs", json={"model": "nope", "prompt": "x"}).status_code == 400
    assert client.post("/api/video/jobs", json={"model": "xyq:A", "prompt": ""}).status_code == 400
    assert client.post("/api/video/jobs", json={"model": "xyq:A", "prompt": "x", "refs": ["0" * 40]}).status_code == 400


def test_quote_and_balances(env):
    client, cloud = env
    q = client.get("/api/video/quote", params={"model": "libtv:Kling", "resolution": "720p", "duration": 5, "ratio": "16:9"}).json()
    assert q["amount"] == 135
    assert cloud.quotes[0]["platform"] == "libtv" and cloud.quotes[0]["model"] == "Kling" and cloud.quotes[0]["duration"] == "5"
    b = client.get("/api/video/balances").json()
    assert b["enabled"] and b["extension"] is True
    assert b["items"][0]["balance"] == 13986 and "raw" not in b["items"][0]


def test_cloud_image_models_in_the_image_card(env):
    client, cloud = env
    models = client.get("/api/models").json()["models"]
    one = next(m for m in models if m["key"] == "xyq:Img One")
    assert one["tag"] == "小云雀" and one["ratios"] == ["16:9", "1:1"] and one["sizes"] == ["1K", "2K"] and one["refs"] is True
    assert next(m for m in models if m["key"] == "lovart:openai/gpt-image-2")["sizes"] == ["1K", "2K", "4K"]

    ref = upload(client, 1)
    ids = client.post("/api/jobs", json={"model": "xyq:Img One", "ratio": "16:9", "size": "2K", "prompt": "<Picture 1> 海", "refs": [ref],
                                         "count": 2}).json()["jobs"]
    assert len(ids) == 2
    jobs = [wait_job(client, i) for i in ids]
    assert all(j["status"] == "done" and j["kind"] == "image" for j in jobs), jobs
    body = cloud.submitted[0]
    assert body["provider"] == "xyq" and body["model"] == "Img One" and body["resolution"] == "2K" and body["count"] == 1
    assert len(body["ref_images"]) == 1
    got = client.get(f"/api/assets/{jobs[0]['result_asset']}")
    assert got.status_code == 200 and got.headers["content-type"] == "image/png"
    assert any(i["asset"] == jobs[0]["result_asset"] for i in client.get("/api/library").json()["generated"])


def test_unconfigured_or_disabled_apis_disappear(tmp_path):
    fake, cloud = FakeFlow(), FakeCloud()
    cloud.lovart_on = False
    settings = Settings(flow_base_url=BASE, flow_api_key="k", data_dir=tmp_path / "data", job_timeout=20, cloud_base_url=CLOUD,
                        apis={"flow": True, "gpt": True, "xyq": False, "libtv": True, "lovart": True})
    app = create_app(settings, FlowClient(BASE, "k", transport=httpx.MockTransport(fake.handle), timeout=20), GptClient("", ""),
                     CloudClient(CLOUD, "", transport=httpx.MockTransport(cloud.handle)))
    with TestClient(app) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "a"}).json()["id"]
        # xyq is switched off here, lovart is not authorised in terry2api: only libtv is left
        assert [m["provider"] for m in client.get("/api/video/models").json()["models"]] == ["libtv"]
        assert {m["key"] for m in client.get("/api/models").json()["models"] if m.get("provider") in ("xyq", "libtv", "lovart")} == set()
        assert [i["provider"] for i in client.get("/api/video/balances").json()["items"]] == ["libtv"]
        assert client.post("/api/video/jobs", json={"model": "xyq:Seedance 2.0", "prompt": "x"}).status_code == 400
        assert client.get("/api/video/quote", params={"model": "lovart:x"}).status_code == 400
        # switching Flow off removes its models and refuses its jobs
        settings.apis["flow"] = False
        assert all(m.get("provider") != "flow" and "flow" not in m["key"] for m in client.get("/api/models").json()["models"])
        r = client.post("/api/jobs", json={"model": "gemini-3.1-flash-image", "ratio": "16:9", "size": "1K", "prompt": "x"})
        assert r.status_code == 400


def test_flow_limits_do_not_touch_the_aggregation_api(tmp_path):
    fake, cloud = FakeFlow(), FakeCloud()
    cloud.polls = -10_000   # tasks stay "running"
    settings = Settings(flow_base_url=BASE, flow_api_key="k", data_dir=tmp_path / "data", job_timeout=20, cloud_base_url=CLOUD,
                        user_concurrency=1, max_parallel_jobs=1, disabled_models=("xyq:Seedance 2.0", "xyq:Img One", "gpt-image"))
    app = create_app(settings, FlowClient(BASE, "k", transport=httpx.MockTransport(fake.handle), timeout=20), GptClient("", ""),
                     CloudClient(CLOUD, "", transport=httpx.MockTransport(cloud.handle)))
    app.state.runner.cloud_poll = 0.05
    import time
    with TestClient(app) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "a"}).json()["id"]
        # the "disabled models" list is Flow only: a cloud model with the same key still shows up and works
        assert "xyq:Img One" in [m["key"] for m in client.get("/api/models").json()["models"]]
        ids = client.post("/api/video/jobs", json={"model": "xyq:Seedance 2.0", "prompt": "x", "count": 3}).json()["jobs"]
        time.sleep(0.6)
        states = [client.get("/api/jobs", params={"ids": i}).json()["jobs"][0]["status"] for i in ids]
        assert states == ["running"] * 3, states   # user_concurrency=1 would have held two of them back
        for i in ids:
            client.post(f"/api/jobs/{i}/cancel")
