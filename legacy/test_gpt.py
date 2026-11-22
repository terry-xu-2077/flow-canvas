"""The ChatGPT (gpt2api) image model next to the Flow ones."""
import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.config import Settings
from server.flow import FlowClient
from server.gpt import GptClient
from test_api import BASE, FakeFlow, png, wait_job

GPT_BASE = "http://gpt.test"


class FakeGpt:
    """Minimal gpt2api stand-in."""

    def __init__(self):
        self.requests: list[dict] = []
        self.connected = True
        self.uploads = 0
        self.media: set[str] = set()
        self.fail_with: str | None = None
        self.quota = {"hour": {"limit": 35, "used": 12, "remaining": 23, "window_seconds": 3600, "resets_in": 1380},
                      "day": {"limit": 120, "used": 40, "remaining": 80, "window_seconds": 86400, "resets_in": 7200}}
        self.result_png = png((200, 60, 160), (256, 384))

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200, json={"ok": True, "extension_connected": self.connected})
        if request.url.path == "/v1/quota":
            return httpx.Response(200, json={"image": self.quota})
        if request.url.path == "/v1/media/upload":
            self.uploads += 1
            ref = "ref_" + f"{self.uploads:032x}"
            self.media.add(ref)
            return httpx.Response(200, json={"id": ref})
        if request.url.path.startswith("/v1/media/"):
            return httpx.Response(200 if request.url.path.rsplit("/", 1)[1] in self.media else 404)
        if request.url.path in ("/v1/images/generations", "/v1/images/edits"):
            self.requests.append({**json.loads(request.content), "_path": request.url.path})
            if self.fail_with:
                return httpx.Response(502, json={"error": {"message": self.fail_with, "type": "bridge_error"}})
            return httpx.Response(200, json={"created": 1, "data": [{"b64_json": base64.b64encode(self.result_png).decode()}]})
        return httpx.Response(404)


def make_env(tmp_path, *, with_gpt=True, flow_ok=True):
    fake, gpt = FakeFlow(), FakeGpt()

    def flow_handler(request: httpx.Request) -> httpx.Response:
        if not flow_ok:
            raise httpx.ConnectError("flow down")
        return fake.handle(request)

    settings = Settings(flow_base_url=BASE, flow_api_key="k", data_dir=tmp_path / "data", job_timeout=20,
                        gpt_base_url=GPT_BASE if with_gpt else "")
    flow = FlowClient(BASE, "k", transport=httpx.MockTransport(flow_handler), timeout=20)
    gpt_client = GptClient(settings.gpt_base_url, "", transport=httpx.MockTransport(gpt.handle), timeout=20)
    return create_app(settings, flow, gpt_client), fake, gpt


@pytest.fixture()
def env(tmp_path):
    app, fake, gpt = make_env(tmp_path)
    with TestClient(app) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "小明"}).json()["id"]
        yield client, fake, gpt


def test_gpt_model_is_listed_after_the_flow_models(env):
    client, _, _ = env
    models = client.get("/api/models").json()["models"]
    assert [m["key"] for m in models] == ["gemini-3.1-flash-image", "gpt-image"]
    gpt = models[1]
    assert gpt["provider"] == "gpt" and gpt["refs"] is True and gpt["available"] is True
    assert gpt["sizes"] == ["1K"] and "2:3" in gpt["ratios"]


def test_gpt_model_hidden_when_not_configured(tmp_path):
    app, _, _ = make_env(tmp_path, with_gpt=False)
    with TestClient(app) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "a"}).json()["id"]
        assert [m["key"] for m in client.get("/api/models").json()["models"]] == ["gemini-3.1-flash-image"]
        r = client.post("/api/jobs", json={"model": "gpt-image", "ratio": "1:1", "prompt": "x"})
        assert r.status_code == 400


def test_gpt_marked_unavailable_when_the_extension_is_not_connected(env):
    client, _, gpt = env
    gpt.connected = False
    gpt_model = client.get("/api/models").json()["models"][-1]
    assert gpt_model["key"] == "gpt-image" and gpt_model["available"] is False


def test_models_still_listed_when_flow_is_down(tmp_path):
    app, _, _ = make_env(tmp_path, flow_ok=False)
    with TestClient(app) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "a"}).json()["id"]
        models = client.get("/api/models").json()["models"]
        assert [m["key"] for m in models] == ["gpt-image"]


def test_gpt_job_end_to_end(env):
    client, fake, gpt = env
    job_id = client.post("/api/jobs", json={"model": "gpt-image", "ratio": "2:3", "size": "1K",
                                            "prompt": "赛博猫娘 <Picture 3>", "node": "n1"}).json()["jobs"][0]
    job = wait_job(client, job_id)
    assert job["status"] == "done", job
    assert job["result_asset"] and (job["result_w"], job["result_h"]) == (256, 384)
    sent = gpt.requests[0]
    assert sent["size"] == "1024x1536" and sent["response_format"] == "b64_json" and sent["n"] == 1
    assert sent["prompt"] == "赛博猫娘 "          # a dangling <Picture N> tag is dropped, not sent
    assert fake.chats == []                       # Flow was not involved


def test_gpt_job_sends_reference_pictures(env):
    client, _, gpt = env
    a1 = client.post("/api/assets", content=png((255, 0, 0))).json()
    a2 = client.post("/api/assets", content=png((0, 255, 0))).json()
    job_id = client.post("/api/jobs", json={"model": "gpt-image", "ratio": "2:3", "prompt": "像 <Picture 1> 的风格画 <Picture 2>",
                                            "refs": [a1["id"], a2["id"]]}).json()["jobs"][0]
    assert wait_job(client, job_id)["status"] == "done"
    path, sent = gpt.requests[-1]["_path"], gpt.requests[-1]
    assert path == "/v1/images/generations" and len(sent["images"]) == 2
    assert sent["prompt"] == "像 第1张图 的风格画 第2张图" and "size" not in sent


def test_gpt_reference_limits(env):
    client, _, gpt = env
    assert client.post("/api/jobs", json={"model": "gpt-image", "ratio": "1:1", "prompt": "x", "refs": ["0" * 40]}).status_code == 400
    ids = [client.post("/api/assets", content=png((i, 0, 0))).json()["id"] for i in range(9)]
    r = client.post("/api/jobs", json={"model": "gpt-image", "ratio": "1:1", "prompt": "x", "refs": ids})
    assert r.status_code == 400 and gpt.requests == []


def test_gpt_rejects_unsupported_ratio(env):
    client, _, _ = env
    r = client.post("/api/jobs", json={"model": "gpt-image", "ratio": "4:3", "prompt": "x"})
    assert r.status_code == 400


def test_gpt_failure_message_reaches_the_job(env):
    client, _, gpt = env
    gpt.fail_with = "extension not connected: load the gpt2api extension"
    job_id = client.post("/api/jobs", json={"model": "gpt-image", "ratio": "1:1", "prompt": "x"}).json()["jobs"][0]
    job = wait_job(client, job_id)
    assert job["status"] == "failed" and "extension not connected" in job["error"]


def test_flow_jobs_are_unaffected(env):
    client, fake, gpt = env
    job_id = client.post("/api/jobs", json={"model": "gemini-3.1-flash-image", "ratio": "1:1", "prompt": "猫"}).json()["jobs"][0]
    assert wait_job(client, job_id)["status"] == "done"
    assert gpt.requests == [] and len(fake.chats) == 1


def test_usage_carries_the_chatgpt_quota(env):
    client, _, gpt = env
    u = client.get("/api/usage").json()
    assert u["gpt"]["hour"]["used"] == 12 and u["gpt"]["hour"]["limit"] == 35 and u["gpt"]["day"]["limit"] == 120
    assert u["image_daily"]                      # the Flow part is still there


def test_usage_still_works_when_only_flow_is_configured(tmp_path):
    app, _, _ = make_env(tmp_path, with_gpt=False)
    with TestClient(app) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "a"}).json()["id"]
        assert client.get("/api/usage").json()["gpt"] is None


def test_usage_shows_the_chatgpt_quota_even_when_flow_is_down(tmp_path):
    app, _, _ = make_env(tmp_path, flow_ok=False)
    with TestClient(app) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "a"}).json()["id"]
        u = client.get("/api/usage").json()
        assert u["image_daily"] == [] and u["gpt"]["hour"]["used"] == 12


def test_job_is_refused_up_front_when_the_hourly_quota_would_be_exceeded(env):
    client, _, gpt = env
    gpt.quota["hour"].update(used=34, remaining=1)
    r = client.post("/api/jobs", json={"model": "gpt-image", "ratio": "1:1", "prompt": "x", "count": 2})
    assert r.status_code == 429
    msg = r.json()["error"]
    assert "最近 1 小时" in msg and "34 / 35" in msg and "23 分钟" in msg
    assert gpt.requests == []
    ok = client.post("/api/jobs", json={"model": "gpt-image", "ratio": "1:1", "prompt": "x", "count": 1})
    assert ok.status_code == 200                  # one more still fits


def test_daily_quota_also_blocks(env):
    client, _, gpt = env
    gpt.quota["day"].update(used=120, remaining=0, resets_in=5400)
    r = client.post("/api/jobs", json={"model": "gpt-image", "ratio": "1:1", "prompt": "x"})
    assert r.status_code == 429 and "最近 24 小时" in r.json()["error"]


def test_unreadable_quota_does_not_block_jobs(env):
    client, _, gpt = env
    gpt.quota = None                                # /v1/quota now answers with junk
    job_id = client.post("/api/jobs", json={"model": "gpt-image", "ratio": "1:1", "prompt": "x"}).json()["jobs"][0]
    assert wait_job(client, job_id)["status"] == "done"


def test_unchanged_reference_pictures_are_uploaded_once(env):
    client, _, gpt = env
    a = client.post("/api/assets", content=png((9, 9, 9))).json()
    body = {"model": "gpt-image", "ratio": "1:1", "prompt": "x", "refs": [a["id"]]}
    for _ in range(2):
        assert wait_job(client, client.post("/api/jobs", json=body).json()["jobs"][0])["status"] == "done"
    assert gpt.uploads == 1 and gpt.requests[0]["images"] == gpt.requests[1]["images"]
    gpt.media.clear()                               # gpt2api forgot it (restart / expiry): upload again
    assert wait_job(client, client.post("/api/jobs", json=body).json()["jobs"][0])["status"] == "done"
    assert gpt.uploads == 2
