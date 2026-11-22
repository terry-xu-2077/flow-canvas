"""Users start with the free models only; the console can switch on the credit-costing ones per user."""
from fastapi.testclient import TestClient

from fake_gateway import make_app, paid_user, wait_job


def models_of(client):
    return {m["key"]: m for m in client.get("/api/models").json()["models"]}


def test_a_new_user_only_sees_free_models_and_options(tmp_path):
    app, fake = make_app(tmp_path)
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "新人", paid=False)
        got = client.get("/api/models").json()
        by = {m["key"]: m for m in got["models"]}
        assert got["paid"] is False
        assert "flow:Nano Banana 2.1" in by and "chatgpt:GPT Image" in by                # Flow and ChatGPT cost no credits
        assert by["xyq:Img One"]["sizes"] == ["1K"] and by["xyq:Img One"]["qualities"] == []   # only the 0-credit size, default quality
        assert by["lovart:openai/gpt-image-2"]["sizes"] == ["1K"]                           # free only with quality "low" at 1K
        assert by["lovart:openai/gpt-image-2"]["qualities"] == ["low"]
        assert by["lovart:openai/gpt-image-2"]["combos"] == [["1K", "low"]]
        assert client.get("/api/video/models").json()["models"] == [] and client.get("/api/video/models").json()["locked"] is True


def test_free_options_work_and_the_rest_is_refused(tmp_path):
    app, fake = make_app(tmp_path)
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "新人", paid=False)
        ok = client.post("/api/jobs", json={"model": "xyq:Img One", "ratio": "1:1", "size": "1K", "prompt": "x"})
        assert ok.status_code == 200 and wait_job(client, ok.json()["jobs"][0])["status"] == "done"
        assert client.post("/api/jobs", json={"model": "xyq:Img One", "size": "2K", "prompt": "x"}).status_code == 403
        assert client.post("/api/jobs", json={"model": "xyq:Img One", "size": "1K", "quality": "high", "prompt": "x"}).status_code == 403
        low = client.post("/api/jobs", json={"model": "lovart:openai/gpt-image-2", "size": "1K", "quality": "low", "prompt": "x"})
        assert low.status_code == 200 and wait_job(client, low.json()["jobs"][0])["status"] == "done"
        assert fake.submitted[-1]["quality"] == "low"
        assert client.post("/api/jobs", json={"model": "lovart:openai/gpt-image-2", "size": "1K", "prompt": "x"}).status_code == 403
        flow = client.post("/api/jobs", json={"model": "flow:Nano Banana 2.1", "size": "2K", "prompt": "x"})
        assert flow.status_code == 200
        v = client.post("/api/video/jobs", json={"model": "xyq:Seedance 2.0", "prompt": "x"})
        assert v.status_code == 403 and "积分模型" in str(v.json())


def test_switching_a_user_on_unlocks_everything(tmp_path):
    app, fake = make_app(tmp_path)
    with TestClient(app) as client:
        uid = paid_user(app, client, "新人", paid=False)
        client.headers["X-User"] = uid
        assert models_of(client)["xyq:Img One"]["sizes"] == ["1K"]
        app.state.store.set_user_paid(uid, True)                       # what the console does
        by = models_of(client)
        assert by["xyq:Img One"]["sizes"] == ["1K", "2K"] and by["xyq:Img One"]["qualities"] == ["low", "high"]
        assert client.get("/api/me").json()["paid"] == 1
        ok = client.post("/api/jobs", json={"model": "xyq:Img One", "size": "2K", "quality": "high", "prompt": "x"})
        assert ok.status_code == 200 and wait_job(client, ok.json()["jobs"][0])["status"] == "done"
        assert client.post("/api/video/jobs", json={"model": "xyq:Seedance 2.0", "prompt": "x"}).status_code == 200
