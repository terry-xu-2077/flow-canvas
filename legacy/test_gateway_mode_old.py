"""use_gateway = true: every generation (Flow, ChatGPT, 小云雀 …) goes through the aggregation API."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from server.app import create_app
from server.cloud import CloudClient
from server.config import Settings
from test_api import png, wait_job
from test_video import CLOUD, FakeCloud

FLOW_MODEL = {"id": "flow:Nano Banana 2.1", "provider": "flow", "kind": "image", "name": "Nano Banana 2.1", "key": "gemini-3.1-flash-image",
              "info": {"ratios": ["16:9", "9:16", "1:1"], "resolutions": ["1K", "2K"]}}
GPT_MODEL = {"id": "chatgpt:GPT Image", "provider": "chatgpt", "kind": "image", "name": "GPT Image", "key": "gpt-image",
             "info": {"ratios": ["1:1", "3:2", "2:3", "16:9", "9:16"], "resolutions": []}}
XYQ_MODEL = {"id": "xyq:Img One", "provider": "xyq", "kind": "image", "name": "Img One", "key": "k", "info": {"ratios": ["1:1"], "resolutions": ["1k", "2k"]}}


class FakeGateway(FakeCloud):
    def __init__(self):
        super().__init__()
        self.providers_on = {"flow": True, "chatgpt": True, "xyq": True, "libtv": True, "lovart": True}

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/models" and request.url.params.get("kind") == "image":
            return httpx.Response(200, json={"models": [FLOW_MODEL, GPT_MODEL, XYQ_MODEL], "errors": {}})
        if path == "/v1/providers":
            return httpx.Response(200, json={"providers": [{"id": k, "usable": v} for k, v in self.providers_on.items()]})
        if path == "/v1/credits":
            return httpx.Response(200, json={"items": [
                {"provider": "flow", "ok": True, "balance": 250, "image_daily": [{"name": "Nano Banana 2.1 / Pro", "used": 3, "limit": 1000}]},
                {"provider": "chatgpt", "ok": True, "balance": None, "quota": {"hour": {"limit": 35, "used": 2}, "day": {"limit": 120, "used": 9}}},
                {"provider": "xyq", "ok": True, "balance": 1272}]})
        return super().handle(request)


def make(tmp_path, **kw):
    fake = FakeGateway()
    settings = Settings(data_dir=tmp_path / "data", job_timeout=20, cloud_base_url=CLOUD, cloud_timeout=20, use_gateway=True, **kw)
    app = create_app(settings, cloud=CloudClient(CLOUD, "", transport=httpx.MockTransport(fake.handle)))
    app.state.runner.cloud_poll = 0.05
    return app, fake, settings


@pytest.fixture()
def env(tmp_path):
    app, fake, settings = make(tmp_path)
    with TestClient(app) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "a"}).json()["id"]
        yield client, fake, settings


def test_models_from_the_gateway(env):
    client, _, _ = env
    models = client.get("/api/models").json()["models"]
    by = {m["key"]: m for m in models}
    assert list(by) == ["flow:Nano Banana 2.1", "chatgpt:GPT Image", "xyq:Img One"]
    flow = by["flow:Nano Banana 2.1"]
    assert flow["tag"] == "Flow" and flow["legacy"] == "gemini-3.1-flash-image" and flow["sizes"] == ["1K", "2K"]
    assert flow["ratios"] == ["16:9", "9:16", "1:1"]
    assert by["chatgpt:GPT Image"]["tag"] == "ChatGPT" and by["chatgpt:GPT Image"]["legacy"] == "gpt-image"
    assert by["chatgpt:GPT Image"]["sizes"] == ["1K"] and by["xyq:Img One"]["sizes"] == ["1K", "2K"]


def test_usage_comes_from_the_gateway_credits(env):
    client, _, _ = env
    u = client.get("/api/usage").json()
    assert u["credits"] == 250 and u["image_daily"][0]["used"] == 3 and u["gpt"]["hour"]["used"] == 2


def test_flow_job_through_the_gateway_with_refs_and_legacy_key(env):
    client, fake, _ = env
    ref = client.post("/api/assets", content=png((1, 2, 3))).json()["id"]
    for _ in range(2):   # the same picture is uploaded to the gateway once
        ids = client.post("/api/jobs", json={"model": "gemini-3.1-flash-image", "ratio": "16:9", "size": "2K", "prompt": "<Picture 1> 在海边",
                                             "refs": [ref], "count": 1}).json()["jobs"]
        job = wait_job(client, ids[0])
        assert job["status"] == "done" and job["kind"] == "image", job
    body = fake.submitted[0]
    assert body["provider"] == "flow" and body["model"] == "Nano Banana 2.1" and body["ratio"] == "16:9" and body["resolution"] == "2K"
    assert body["prompt"] == "<Picture 1> 在海边"          # the gateway turns the tag into @1 for Flow
    assert len(fake.media) == 1 and fake.media[body["ref_images"][0]] == png((1, 2, 3))
    assert client.get(f"/api/assets/{job['result_asset']}").headers["content-type"] == "image/png"


def test_chatgpt_and_cloud_jobs_share_the_same_path(env):
    client, fake, _ = env
    for model in ("chatgpt:GPT Image", "xyq:Img One"):
        ids = client.post("/api/jobs", json={"model": model, "ratio": "1:1", "size": "1K", "prompt": "x", "count": 2}).json()["jobs"]
        assert len(ids) == 2
        assert all(wait_job(client, i)["status"] == "done" for i in ids)
    assert [b["provider"] for b in fake.submitted] == ["chatgpt", "chatgpt", "xyq", "xyq"] or \
        sorted(b["provider"] for b in fake.submitted) == ["chatgpt", "chatgpt", "xyq", "xyq"]


def test_big_flow_sizes_are_made_smaller_and_enlarged_by_comfyui(tmp_path):
    app, fake, _ = make(tmp_path, comfy_url="http://comfy.test")
    with TestClient(app) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "a"}).json()["id"]
        flow = next(m for m in client.get("/api/models").json()["models"] if m["provider"] == "flow")
        assert flow["sizes"] == ["1K", "2K", "4K", "6K"]
        jid = client.post("/api/jobs", json={"model": flow["key"], "ratio": "16:9", "size": "4K", "prompt": "x"}).json()["jobs"][0]
        wait_job(client, jid)               # ComfyUI is not reachable here: the job ends, what matters is what the gateway was asked for
        assert fake.submitted[0]["resolution"] == "2K"   # the biggest size Flow makes itself
        extra = app.state.store.get_job(jid)["extra"]
        assert extra["upscale_to"] == 4096 and extra["size"] == "4K"


def test_switched_off_sources_disappear_and_are_refused(tmp_path):
    app, fake, settings = make(tmp_path, apis={"flow": False, "gpt": True, "xyq": True, "libtv": True, "lovart": True})
    with TestClient(app) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "a"}).json()["id"]
        assert [m["provider"] for m in client.get("/api/models").json()["models"]] == ["chatgpt", "xyq"]
        r = client.post("/api/jobs", json={"model": "flow:Nano Banana 2.1", "ratio": "16:9", "size": "1K", "prompt": "x"})
        assert r.status_code == 400
        assert client.get("/api/usage").json()["credits"] is None


def test_gateway_down_is_reported(tmp_path):
    app, fake, _ = make(tmp_path)

    def down(request):
        raise httpx.ConnectError("gateway down")
    app.state.cloud._http = httpx.AsyncClient(transport=httpx.MockTransport(down))
    with TestClient(app) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "a"}).json()["id"]
        assert client.get("/api/models").status_code == 502
