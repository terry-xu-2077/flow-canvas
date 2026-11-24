"""Boards, users, assets and the image job path (every generation goes through the aggregation API)."""
import io
import urllib.parse

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from fake_gateway import png, wait_job, make_app, paid_user


@pytest.fixture()
def env(tmp_path):
    app, fake = make_app(tmp_path)
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "小明")
        client.post("/api/users", json={"name": "小红"})
        yield client, fake


def test_user_header_required(env):
    client, _ = env
    assert client.get("/api/boards", headers={"X-User": ""}).status_code == 401


def test_board_lifecycle_is_per_user(env):
    client, _ = env
    bid = client.post("/api/boards", json={"name": "分镜"}).json()["id"]
    data = {"nodes": [{"id": "n1"}], "edges": [], "viewport": {"x": 1, "y": 2, "zoom": 1}}
    assert client.put(f"/api/boards/{bid}", json={"data": data}).json()["ok"] is True
    got = client.get(f"/api/boards/{bid}").json()
    assert got["data"] == data and got["name"] == "分镜"
    other = {"X-User": urllib.parse.quote("小红")}
    assert client.get(f"/api/boards/{bid}", headers=other).status_code == 404
    assert client.get("/api/boards", headers=other).json()["boards"] == []
    assert client.put(f"/api/boards/{bid}", json={"name": "改名"}).status_code == 200
    assert client.get("/api/boards").json()["boards"][0]["name"] == "改名"
    assert client.delete(f"/api/boards/{bid}").status_code == 200
    assert client.get(f"/api/boards/{bid}").status_code == 404


def test_asset_upload_dedup_thumb_and_validation(env):
    client, _ = env
    a = client.post("/api/assets", content=png((1, 2, 3), (800, 600))).json()
    b = client.post("/api/assets", content=png((1, 2, 3), (800, 600))).json()
    assert a["id"] == b["id"] and (a["w"], a["h"]) == (800, 600)
    full = client.get(f"/api/assets/{a['id']}")
    assert full.status_code == 200 and full.headers["content-type"] == "image/png"
    thumb = client.get(f"/api/assets/{a['id']}", params={"w": 200})
    assert thumb.headers["content-type"] == "image/webp" and Image.open(io.BytesIO(thumb.content)).width == 200
    assert "attachment" in client.get(f"/api/assets/{a['id']}", params={"download": 1}).headers["content-disposition"]
    assert client.post("/api/assets", content=b"not an image").status_code == 400
    assert client.get("/api/assets/" + "0" * 40).status_code == 404
    assert client.get("/api/assets/../etc").status_code in (404, 422)


def test_text_to_image_job_end_to_end(env):
    client, fake = env
    ids = client.post("/api/jobs", json={"model": "flow:Nano Banana 2.1", "ratio": "16:9", "size": "1K", "prompt": "海边日落", "count": 2}).json()["jobs"]
    assert len(ids) == 2
    jobs = [wait_job(client, i) for i in ids]
    assert all(j["status"] == "done" and j["kind"] == "image" and j["result_asset"] for j in jobs)
    assert jobs[0]["result_asset"] == jobs[1]["result_asset"]                       # same bytes, one asset
    assert len(fake.submitted) == 2 and all(b["count"] == 1 and b["provider"] == "flow" for b in fake.submitted)   # one task per image
    assert fake.submitted[0]["prompt"] == "海边日落" and fake.submitted[0]["ratio"] == "16:9"
    lib = client.get("/api/library").json()["generated"]
    assert len(lib) == 1 and lib[0]["asset"] == jobs[0]["result_asset"]


def test_reference_pictures_are_uploaded_once_and_tags_go_through(env):
    client, fake = env
    ref = client.post("/api/assets", content=png((1, 2, 3))).json()["id"]
    for _ in range(2):
        job = wait_job(client, client.post("/api/jobs", json={"model": "flow:Nano Banana 2.1", "prompt": "<Picture 1> 在海边",
                                                               "refs": [ref]}).json()["jobs"][0])
        assert job["status"] == "done", job
    assert len(fake.media) == 1                                                      # the gateway got the picture once
    body = fake.submitted[0]
    assert fake.media[body["ref_images"][0]] == png((1, 2, 3)) and body["prompt"] == "<Picture 1> 在海边"


def test_failed_generation_reports_the_gateways_message(env):
    client, fake = env
    fake.fail_with = "积分不足"
    job = wait_job(client, client.post("/api/jobs", json={"model": "flow:Nano Banana 2.1", "prompt": "x"}).json()["jobs"][0])
    assert job["status"] == "failed" and "积分不足" in job["error"]


def test_job_validation_and_ownership(env):
    client, _ = env
    assert client.post("/api/jobs", json={"model": "nope:x", "prompt": "x"}).status_code == 400
    assert client.post("/api/jobs", json={"model": "flow:Nano Banana 2.1", "prompt": "x", "refs": ["0" * 40]}).status_code == 400
    assert client.post("/api/jobs", json={"model": "flow:Nano Banana 2.1", "prompt": ""}).status_code == 422
    assert client.post("/api/jobs", json={"model": "flow:Nano Banana 2.1", "prompt": "x", "ratio": "16:9", "size": "6K"}).status_code == 400   # no ComfyUI
    job_id = client.post("/api/jobs", json={"model": "flow:Nano Banana 2.1", "prompt": "x"}).json()["jobs"][0]
    other = {"X-User": urllib.parse.quote("小红")}
    assert client.get("/api/jobs", params={"ids": job_id}, headers=other).json()["jobs"] == []
    assert client.post(f"/api/jobs/{job_id}/cancel", headers=other).status_code == 404


def test_unfinished_jobs_fail_on_restart(tmp_path):
    app, _ = make_app(tmp_path)
    app.state.store.create_job({"id": "a" * 16, "user": "u", "model": "m", "prompt": "p"})
    with TestClient(app):
        pass
    job = app.state.store.get_job("a" * 16)
    assert job["status"] == "failed" and "中断" in job["error"]


def test_disabled_flow_models_sizes_and_count_limit(tmp_path):
    app, _ = make_app(tmp_path, disabled_sizes=("2K",), max_count=2)
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "小明")
        models = client.get("/api/models").json()
        flow = next(m for m in models["models"] if m["provider"] == "flow")
        assert flow["sizes"] == ["1K"] and models["max_count"] == 2
        ok = {"model": flow["key"], "prompt": "x"}
        assert client.post("/api/jobs", json={**ok, "size": "2K"}).status_code == 400
        assert client.post("/api/jobs", json={**ok, "count": 3}).status_code == 400
        assert client.post("/api/jobs", json={**ok, "count": 2}).status_code == 200


def test_users_have_uuid_unique_names_and_editable_profile(env):
    client, _ = env
    me = client.get("/api/me").json()
    assert len(me["id"]) == 32 and me["name"] == "小明" and me["avatar"] == ""
    assert client.post("/api/users", json={"name": "小明"}).status_code == 409
    assert client.post("/api/users", json={"name": "bad/name"}).status_code == 400
    listed = {u["name"]: u for u in client.get("/api/users", headers={"X-User": ""}).json()["users"]}
    assert set(listed) == {"小明", "小红"} and listed["小明"]["id"] == me["id"]
    bid = client.post("/api/boards", json={"name": "a"}).json()["id"]
    assert client.put("/api/me", json={"name": "小红"}).status_code == 409
    assert client.put("/api/me", json={"name": "阿明"}).json()["name"] == "阿明"
    assert client.get(f"/api/boards/{bid}").status_code == 200
    assert client.put("/api/me", json={"avatar": "emoji:🐱"}).json()["avatar"] == "emoji:🐱"
    assert client.put("/api/me", json={"avatar": "http://evil"}).status_code == 400
    assert client.put("/api/me", json={"avatar": "asset:" + "0" * 40}).status_code == 400
    assert client.put("/api/me", json={"avatar": ""}).json()["avatar"] == ""


def test_old_name_keyed_data_is_migrated_to_user_ids(tmp_path):
    from server.db import Store
    path = tmp_path / "old.db"
    store = Store(path)
    store.create_board("老用户", "b1", "旧画板")  # as written by the version that keyed boards by name
    store._db.execute("DELETE FROM users"); store._db.commit()
    store = Store(path)
    user = store.get_user_by_name("老用户")
    assert user and len(user["id"]) == 32
    assert store.list_boards(user["id"])[0]["name"] == "旧画板"
    assert store.list_boards("老用户") == []
