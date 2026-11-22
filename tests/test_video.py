"""The video generation card, and the other tests of what goes through the aggregation API besides plain Flow images."""
import pytest
from fastapi.testclient import TestClient

from fake_gateway import VIDEO, make_app, png, wait_job, paid_user


@pytest.fixture()
def env(tmp_path):
    app, fake = make_app(tmp_path)
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "小明")
        yield client, fake


def upload(client, n: int = 0) -> str:
    return client.post("/api/assets", content=png((20 * n, 40, 90))).json()["id"]


def test_models_and_info(env):
    client, _ = env
    r = client.get("/api/video/models").json()
    assert r["enabled"] and [m["key"] for m in r["models"]] == ["xyq:Seedance 2.0", "libtv:Kling"]
    assert r["models"][0]["tag"] == "小云雀" and r["models"][1]["vip"] is True
    assert client.get("/api/video/model_info", params={"model": "libtv:Kling"}).json()["sound"] is True


def test_text_to_video_stores_asset(env):
    client, fake = env
    ids = client.post("/api/video/jobs", json={"model": "xyq:Seedance 2.0", "prompt": "海边日落", "ratio": "16:9", "duration": 5}).json()["jobs"]
    job = wait_job(client, ids[0])
    assert job["status"] == "done" and job["kind"] == "video", job
    body = fake.submitted[0]
    assert body["provider"] == "xyq" and body["model"] == "Seedance 2.0" and body["duration"] == 5
    assert "first_frame" not in body and "ref_images" not in body
    got = client.get(f"/api/assets/{job['result_asset']}")
    assert got.status_code == 200 and got.content == VIDEO and got.headers["content-type"] == "video/mp4"
    assert client.get(f"/api/assets/{job['result_asset']}?w=256").content == VIDEO   # no thumbnail for videos
    assert client.get("/api/library").json()["generated"] == []                      # the image library skips videos


def test_frames_and_references(env):
    client, fake = env
    a, b, c = upload(client, 1), upload(client, 2), upload(client, 3)
    mk = lambda **kw: client.post("/api/video/jobs", json={"model": "libtv:Kling", "prompt": "<Picture 1> 走向 <Picture 2>", **kw}).json()
    wait_job(client, mk(refs=[a])["jobs"][0])
    wait_job(client, mk(refs=[a, b])["jobs"][0])
    wait_job(client, mk(refs=[a, b, c])["jobs"][0])
    wait_job(client, mk(refs=[a, b], mode="reference")["jobs"][0])
    one, two, three, ref2 = fake.submitted
    assert fake.media[one["first_frame"]] == png((20, 40, 90)) and "last_frame" not in one
    assert "last_frame" in two and "<Picture" not in two["prompt"] and "第1张图" in two["prompt"]
    assert len(three["ref_images"]) == 3 and "<Picture 1>" in three["prompt"]
    assert len(ref2["ref_images"]) == 2 and "first_frame" not in ref2


def test_failure_is_reported(env):
    client, fake = env
    fake.fail_with = "积分不足"
    job = wait_job(client, client.post("/api/video/jobs", json={"model": "xyq:Seedance 2.0", "prompt": "x"}).json()["jobs"][0])
    assert job["status"] == "failed" and "积分不足" in job["error"]


def test_cancel_stops_remote_task(env):
    client, fake = env
    fake.hold = True
    jid = client.post("/api/video/jobs", json={"model": "xyq:Seedance 2.0", "prompt": "x"}).json()["jobs"][0]
    import time
    time.sleep(0.5)
    assert client.post(f"/api/jobs/{jid}/cancel").json()["cancelled"] is True
    job = wait_job(client, jid)
    assert job["status"] == "cancelled" and fake.cancelled == ["t1"]


def test_validation(env):
    client, _ = env
    assert client.post("/api/video/jobs", json={"model": "nope", "prompt": "x"}).status_code == 400
    assert client.post("/api/video/jobs", json={"model": "xyq:A", "prompt": ""}).status_code == 400
    assert client.post("/api/video/jobs", json={"model": "xyq:A", "prompt": "x", "refs": ["0" * 40]}).status_code == 400


def test_quote_and_balances(env):
    client, fake = env
    q = client.get("/api/video/quote", params={"model": "libtv:Kling", "resolution": "720p", "duration": 5, "ratio": "16:9"}).json()
    assert q["amount"] == 135
    assert fake.quotes[0]["platform"] == "libtv" and fake.quotes[0]["model"] == "Kling" and fake.quotes[0]["duration"] == "5"
    b = client.get("/api/video/balances").json()
    assert b["enabled"] and b["extension"] is True
    assert [i["provider"] for i in b["items"]] == ["xyq", "libtv"]                  # only the platforms the top bar shows
    assert b["items"][1]["balance"] == 13986 and "raw" not in b["items"][1]


def test_sources_that_are_off_in_the_gateway_disappear(tmp_path):
    app, fake = make_app(tmp_path)
    fake.usable.update(xyq=False, lovart=False)
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "a")
        assert [m["provider"] for m in client.get("/api/video/models").json()["models"]] == ["libtv"]
        assert [i["provider"] for i in client.get("/api/video/balances").json()["items"]] == ["libtv"]
        assert client.post("/api/video/jobs", json={"model": "xyq:Seedance 2.0", "prompt": "x"}).status_code == 400
        assert client.get("/api/video/quote", params={"model": "lovart:x"}).status_code == 400


def test_user_limit_holds_back_every_model(tmp_path):
    app, fake = make_app(tmp_path, user_concurrency=1)
    fake.hold = True
    import time
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "a")
        video = client.post("/api/video/jobs", json={"model": "xyq:Seedance 2.0", "prompt": "x", "count": 3}).json()["jobs"]
        flow = client.post("/api/jobs", json={"model": "flow:Nano Banana 2.1", "prompt": "x", "count": 3}).json()["jobs"]
        time.sleep(0.6)
        state = lambda ids: [client.get("/api/jobs", params={"ids": i}).json()["jobs"][0]["status"] for i in ids]
        assert sorted(state(video + flow)) == ["queued"] * 5 + ["running"]           # one at a time per user, whatever the model
        for i in video + flow:
            client.post(f"/api/jobs/{i}/cancel")
