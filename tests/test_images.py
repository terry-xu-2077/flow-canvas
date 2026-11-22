"""The image card's models, quotas and jobs: Flow, ChatGPT and the other sources all behind the aggregation API."""
import pytest
from fastapi.testclient import TestClient

from fake_gateway import make_app, png, wait_job, paid_user


@pytest.fixture()
def env(tmp_path):
    app, fake = make_app(tmp_path)
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "a")
        yield client, fake


def test_models_come_from_the_gateway(env):
    client, _ = env
    by = {m["key"]: m for m in client.get("/api/models").json()["models"]}
    assert list(by) == ["flow:Nano Banana 2.1", "chatgpt:GPT Image", "xyq:Img One", "lovart:openai/gpt-image-2"]
    flow = by["flow:Nano Banana 2.1"]
    assert flow["tag"] == "Flow" and flow["legacy"] == "gemini-3.1-flash-image" and flow["sizes"] == ["1K", "2K"]
    assert flow["ratios"] == ["16:9", "9:16", "1:1"]
    assert by["chatgpt:GPT Image"]["tag"] == "ChatGPT" and by["chatgpt:GPT Image"]["legacy"] == "gpt-image"
    assert by["chatgpt:GPT Image"]["sizes"] == ["1K"] and by["xyq:Img One"]["sizes"] == ["1K", "2K"]
    assert by["lovart:openai/gpt-image-2"]["sizes"] == ["1K", "2K", "4K"]            # unknown: the usual three


def test_usage_comes_from_the_gateway_credits(env):
    client, _ = env
    u = client.get("/api/usage").json()
    assert u["credits"] == 250 and u["image_daily"][0]["used"] == 3 and u["gpt"]["hour"]["used"] == 2


def test_old_boards_keep_working_through_the_legacy_keys(env):
    client, fake = env
    ref = client.post("/api/assets", content=png((1, 2, 3))).json()["id"]
    for old in ("gemini-3.1-flash-image", "gpt-image"):
        job = wait_job(client, client.post("/api/jobs", json={"model": old, "ratio": "16:9", "size": "2K" if old.startswith("g") else "1K",
                                                              "prompt": "x", "refs": [ref]}).json()["jobs"][0])
        assert job["status"] == "done", job
    flow, gpt = fake.submitted
    assert flow["provider"] == "flow" and flow["model"] == "Nano Banana 2.1" and flow["resolution"] == "2K"
    assert gpt["provider"] == "chatgpt" and gpt["model"] == "GPT Image"


def test_every_source_shares_the_same_path(env):
    client, fake = env
    for model in ("chatgpt:GPT Image", "xyq:Img One", "lovart:openai/gpt-image-2"):
        ids = client.post("/api/jobs", json={"model": model, "ratio": "1:1", "size": "1K", "prompt": "x", "count": 2}).json()["jobs"]
        assert len(ids) == 2 and all(wait_job(client, i)["status"] == "done" for i in ids)
    assert sorted(b["provider"] for b in fake.submitted) == ["chatgpt"] * 2 + ["lovart"] * 2 + ["xyq"] * 2


def test_big_flow_sizes_are_made_smaller_and_enlarged_by_comfyui(tmp_path):
    app, fake = make_app(tmp_path, comfy_url="http://comfy.test")
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "a")
        flow = next(m for m in client.get("/api/models").json()["models"] if m["provider"] == "flow")
        assert flow["sizes"] == ["1K", "2K", "4K", "6K"]
        jid = client.post("/api/jobs", json={"model": flow["key"], "ratio": "16:9", "size": "4K", "prompt": "x"}).json()["jobs"][0]
        wait_job(client, jid)               # ComfyUI is not reachable here: what matters is what the gateway was asked for
        assert fake.submitted[0]["resolution"] == "2K"      # the biggest size Flow makes itself
        extra = app.state.store.get_job(jid)["extra"]
        assert extra["upscale_to"] == 4096 and extra["size"] == "4K"


def test_a_source_that_is_off_in_the_gateway_disappears(tmp_path):
    app, fake = make_app(tmp_path)
    fake.usable["flow"] = False
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "a")
        assert "flow" not in [m["provider"] for m in client.get("/api/models").json()["models"]]
        assert client.post("/api/jobs", json={"model": "flow:Nano Banana 2.1", "prompt": "x"}).status_code == 400
        assert client.get("/api/usage").json()["credits"] is None


def test_gateway_down_is_reported(tmp_path):
    import httpx
    app, _ = make_app(tmp_path)

    def down(request):
        raise httpx.ConnectError("gateway down")
    app.state.gateway._http = httpx.AsyncClient(transport=httpx.MockTransport(down))
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "a")
        assert client.get("/api/models").status_code == 502
        assert client.get("/api/usage").status_code == 502


def test_finished_jobs_say_which_source_and_model_made_them(env):
    client, _ = env
    for model, label in (("flow:Nano Banana 2.1", "Flow · Nano Banana 2.1"), ("chatgpt:GPT Image", "ChatGPT · GPT Image"),
                         ("lovart:openai/gpt-image-2", "Lovart · openai/gpt-image-2")):
        jid = client.post("/api/jobs", json={"model": model, "size": "1K", "prompt": "x"}).json()["jobs"][0]
        assert wait_job(client, jid)["label"] == label
