import io
import json
import time
import urllib.parse

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from server.app import create_app
from server.config import Settings
from server.flow import FlowClient, build_catalog, model_id

BASE = "http://flow.test"


def png(color=(200, 30, 30), size=(64, 48)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


class FakeFlow:
    """Minimal flow2api stand-in recording what the service sends."""

    def __init__(self):
        self.uploads: list[bytes] = []
        self.chats: list[dict] = []
        self.media_alive = True
        self.fail_with: str | None = None
        self.status_chunks: list = []
        self.no_result = False
        self.result_png = png((10, 120, 220), (320, 200))

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/models":
            ids = ["gemini-3.1-flash-image-landscape", "gemini-3.1-flash-image-square",
                   "gemini-3.1-flash-image-landscape-2k", "veo-3.1-fast-8s-landscape"]
            return httpx.Response(200, json={"data": [{"id": i, "description": "Nano Banana 2.1 · 图片" if "image" in i else "v"}
                                                      for i in ids]})
        if path == "/health":
            return httpx.Response(200, json={"backend_running": True})
        if path == "/v1/usage":
            self.usage_calls = getattr(self, "usage_calls", 0) + 1
            return httpx.Response(200, json={"date": "2026-11-11", "credits": 250, "image_daily": [{"name": "Nano", "used": 3, "limit": 1000}]})
        if path == "/v1/media/upload":
            self.uploads.append(request.content)
            return httpx.Response(200, json={"id": f"up{len(self.uploads)}"})
        if path.startswith("/v1/media/") and request.method == "HEAD":
            return httpx.Response(200 if self.media_alive else 404)
        if path == "/v1/chat/completions":
            body = json.loads(request.content)
            self.chats.append(body)
            if self.fail_with:
                chunks = [{"error": {"message": self.fail_with}}]
            elif self.status_chunks:
                chunks = list(self.status_chunks)
                if not self.no_result:
                    chunks.append({"choices": [{"delta": {"content": f"![Generated Image](http://localhost:9999/tmp/r{len(self.chats)}.png)"}}]})
            else:
                chunks = [{"choices": [{"delta": {"content": "✨ 图片生成任务已启动\n"}}]},
                          {"choices": [{"delta": {"content": "生成进度: 50%\n"}}]},
                          {"choices": [{"delta": {"content": "正在打码验证码\n"}}]},
                          {"choices": [{"delta": {"content": f"![Generated Image](http://localhost:9999/tmp/r{len(self.chats)}.png)"}}]}]
            sse = "".join(f"data: {json.dumps(c, ensure_ascii=False)}\n\n" for c in chunks) + "data: [DONE]\n\n"
            return httpx.Response(200, content=sse.encode("utf-8"), headers={"content-type": "text/event-stream"})
        if path.startswith("/tmp/"):
            return httpx.Response(200, content=self.result_png)
        return httpx.Response(404)


@pytest.fixture()
def env(tmp_path):
    fake = FakeFlow()
    settings = Settings(flow_base_url=BASE, flow_api_key="k", data_dir=tmp_path / "data", job_timeout=20)
    flow = FlowClient(BASE, "k", transport=httpx.MockTransport(fake.handle), timeout=20)
    app = create_app(settings, flow)
    with TestClient(app) as client:
        client.post("/api/users", json={"name": "小红"})
        me = client.post("/api/users", json={"name": "小明"}).json()
        client.headers["X-User"] = me["id"]
        yield client, fake, settings


def wait_job(client, job_id, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get("/api/jobs", params={"ids": job_id}).json()["jobs"][0]
        if job["status"] in ("done", "failed", "cancelled"):
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_user_header_required(env):
    client, _, _ = env
    r = client.get("/api/boards", headers={"X-User": ""})
    assert r.status_code == 401


def test_models_are_grouped_into_families(env):
    client, _, _ = env
    models = client.get("/api/models").json()["models"]
    assert len(models) == 1
    assert models[0]["key"] == "gemini-3.1-flash-image"
    assert models[0]["ratios"] == ["16:9", "1:1"]
    assert models[0]["sizes"] == ["1K", "2K"]


def test_model_id_composition():
    assert model_id("gemini-3.1-flash-image", "16:9", "1K") == "gemini-3.1-flash-image-landscape"
    assert model_id("gemini-3.1-flash-image", "1:1", "2K") == "gemini-3.1-flash-image-square-2k"
    with pytest.raises(Exception):
        model_id("gemini-3.1-flash-image", "5:7", "1K")


def test_board_lifecycle_is_per_user(env):
    client, _, _ = env
    created = client.post("/api/boards", json={"name": "分镜"}).json()
    bid = created["id"]
    data = {"nodes": [{"id": "n1"}], "edges": [], "viewport": {"x": 1, "y": 2, "zoom": 1}}
    assert client.put(f"/api/boards/{bid}", json={"data": data}).json() == {"ok": True}
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
    client, _, _ = env
    a = client.post("/api/assets", content=png((1, 2, 3), (800, 600))).json()
    b = client.post("/api/assets", content=png((1, 2, 3), (800, 600))).json()
    assert a["id"] == b["id"] and (a["w"], a["h"]) == (800, 600)
    full = client.get(f"/api/assets/{a['id']}")
    assert full.status_code == 200 and full.headers["content-type"] == "image/png"
    thumb = client.get(f"/api/assets/{a['id']}", params={"w": 200})
    assert thumb.headers["content-type"] == "image/webp"
    assert Image.open(io.BytesIO(thumb.content)).width == 200
    assert "attachment" in client.get(f"/api/assets/{a['id']}", params={"download": 1}).headers["content-disposition"]
    assert client.post("/api/assets", content=b"not an image").status_code == 400
    assert client.get("/api/assets/" + "0" * 40).status_code == 404
    assert client.get("/api/assets/../etc").status_code in (404, 422)


def test_text_to_image_job_end_to_end(env):
    client, fake, settings = env
    r = client.post("/api/jobs", json={"model": "gemini-3.1-flash-image", "ratio": "1:1", "size": "2K",
                                       "prompt": "一只猫", "node": "n1"})
    job_id = r.json()["jobs"][0]
    job = wait_job(client, job_id)
    assert job["status"] == "done", job
    assert job["node"] == "n1"
    sent = fake.chats[0]
    assert sent["model"] == "gemini-3.1-flash-image-square-2k"
    assert sent["messages"][0]["content"] == "一只猫" and sent["stream"] is True
    res = client.get(f"/api/assets/{job['result_asset']}")
    assert res.status_code == 200 and Image.open(io.BytesIO(res.content)).size == (320, 200)


def test_progress_hides_captcha_details(env):
    client, _, _ = env
    job_id = client.post("/api/jobs", json={"model": "gemini-3.1-flash-image", "prompt": "x"}).json()["jobs"][0]
    job = wait_job(client, job_id)
    assert job["status"] == "done"
    assert "打码" not in json.dumps(job, ensure_ascii=False)


def test_reference_images_are_uploaded_once_and_sent_as_refs(env):
    client, fake, _ = env
    a1 = client.post("/api/assets", content=png((9, 9, 9))).json()["id"]
    a2 = client.post("/api/assets", content=png((8, 8, 8))).json()["id"]
    body = {"model": "gemini-3.1-flash-image", "prompt": "融合", "refs": [a1, a2]}
    wait_job(client, client.post("/api/jobs", json=body).json()["jobs"][0])
    parts = fake.chats[0]["messages"][0]["content"]
    assert parts[0] == {"type": "text", "text": "融合"}
    assert [p["image_url"]["url"] for p in parts[1:]] == ["ref://up1", "ref://up2"]
    assert len(fake.uploads) == 2
    # the second job re-uses the cached upload ids (HEAD says they still exist)
    wait_job(client, client.post("/api/jobs", json=body).json()["jobs"][0])
    assert len(fake.uploads) == 2
    # ...and re-uploads when flow2api lost them
    fake.media_alive = False
    wait_job(client, client.post("/api/jobs", json=body).json()["jobs"][0])
    assert len(fake.uploads) == 4


def test_count_creates_parallel_jobs(env):
    client, fake, _ = env
    ids = client.post("/api/jobs", json={"model": "gemini-3.1-flash-image", "prompt": "x", "count": 4}).json()["jobs"]
    assert len(set(ids)) == 4
    results = {wait_job(client, i)["result_asset"] for i in ids}
    assert len(fake.chats) == 4 and results  # identical bytes dedupe to one asset


def test_failed_generation_reports_error(env):
    client, fake, _ = env
    fake.fail_with = "没有可用的Token进行图片生成"
    job = wait_job(client, client.post("/api/jobs", json={"model": "gemini-3.1-flash-image", "prompt": "x"}).json()["jobs"][0])
    assert job["status"] == "failed" and "没有可用的Token" in job["error"]


def test_job_validation_and_ownership(env):
    client, _, _ = env
    assert client.post("/api/jobs", json={"model": "m", "prompt": "x", "ratio": "5:7"}).status_code == 400
    assert client.post("/api/jobs", json={"model": "m", "prompt": "x", "refs": ["0" * 40]}).status_code == 400
    assert client.post("/api/jobs", json={"model": "m", "prompt": ""}).status_code == 422
    job_id = client.post("/api/jobs", json={"model": "gemini-3.1-flash-image", "prompt": "x"}).json()["jobs"][0]
    other = {"X-User": urllib.parse.quote("小红")}
    assert client.get("/api/jobs", params={"ids": job_id}, headers=other).json()["jobs"] == []
    assert client.post(f"/api/jobs/{job_id}/cancel", headers=other).status_code == 404


def test_catalog_builder_ignores_non_image_models():
    out = build_catalog({"veo-3.1-fast-8s-landscape": "x", "gemini-3.1-flash-image-landscape": "Nano · y"})
    assert [m["key"] for m in out] == ["gemini-3.1-flash-image"]


def test_unfinished_jobs_fail_on_restart(tmp_path):
    fake = FakeFlow()
    settings = Settings(flow_base_url=BASE, flow_api_key="k", data_dir=tmp_path / "data")
    flow = FlowClient(BASE, "k", transport=httpx.MockTransport(fake.handle))
    app = create_app(settings, flow)
    app.state.store.create_job({"id": "a" * 16, "user": "u", "model": "m", "prompt": "p"})
    with TestClient(app):
        pass
    job = app.state.store.get_job("a" * 16)
    assert job["status"] == "failed" and "中断" in job["error"]


def test_disabled_options_are_hidden_and_refused(tmp_path):
    fake = FakeFlow()
    settings = Settings(flow_base_url=BASE, flow_api_key="k", data_dir=tmp_path / "data",
                        disabled_models=("gemini-3.1-flash-image",), max_count=2)
    flow = FlowClient(BASE, "k", transport=httpx.MockTransport(fake.handle))
    with TestClient(create_app(settings, flow)) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "小明"}).json()["id"]
        assert client.get("/api/models").json() == {"models": [], "max_count": 2, "upscale": {"enabled": False, "options": []}}
        r = client.post("/api/jobs", json={"model": "gemini-3.1-flash-image", "prompt": "x"})
        assert r.status_code == 400 and "关闭" in r.json()["error"]


def test_disabled_sizes_and_count_limit(tmp_path):
    fake = FakeFlow()
    settings = Settings(flow_base_url=BASE, flow_api_key="k", data_dir=tmp_path / "data",
                        disabled_sizes=("2K",), max_count=2)
    flow = FlowClient(BASE, "k", transport=httpx.MockTransport(fake.handle))
    with TestClient(create_app(settings, flow)) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "小明"}).json()["id"]
        models = client.get("/api/models").json()
        assert models["models"][0]["sizes"] == ["1K"] and models["max_count"] == 2
        ok = {"model": "gemini-3.1-flash-image", "prompt": "x"}
        assert client.post("/api/jobs", json={**ok, "size": "2K"}).status_code == 400
        assert client.post("/api/jobs", json={**ok, "count": 3}).status_code == 400
        assert client.post("/api/jobs", json={**ok, "count": 2}).status_code == 200


def test_picture_tags_follow_the_submitted_reference_order(env):
    client, fake, _ = env
    a1 = client.post("/api/assets", content=png((9, 9, 9))).json()["id"]
    a2 = client.post("/api/assets", content=png((8, 8, 8))).json()["id"]
    body = {"model": "gemini-3.1-flash-image", "refs": [a1, a2],
            "prompt": "把<Picture 1>里的猫放进<Picture 2>2个人的房间"}
    wait_job(client, client.post("/api/jobs", json=body).json()["jobs"][0])
    assert fake.chats[0]["messages"][0]["content"][0]["text"] == "把@1里的猫放进@2 2个人的房间"
    wait_job(client, client.post("/api/jobs", json={**body, "prompt": "原样 <picture   2> 文本"}).json()["jobs"][0])
    assert fake.chats[1]["messages"][0]["content"][0]["text"] == "原样 @2 文本"


def test_picture_tags_outside_the_reference_list_are_removed(env):
    client, fake, _ = env
    a1 = client.post("/api/assets", content=png((9, 9, 9))).json()["id"]
    body = {"model": "gemini-3.1-flash-image", "refs": [a1], "prompt": "<Picture 1>和<Picture 2>和<Picture 0>"}
    wait_job(client, client.post("/api/jobs", json=body).json()["jobs"][0])
    assert fake.chats[0]["messages"][0]["content"][0]["text"] == "@1和和"
    wait_job(client, client.post("/api/jobs", json={"model": "gemini-3.1-flash-image", "prompt": "无参考 <Picture 1> 图"}).json()["jobs"][0])
    assert fake.chats[1]["messages"][0]["content"] == "无参考  图"


def test_usage_is_passed_through_and_cached(env):
    client, fake, _ = env
    first = client.get("/api/usage").json()
    assert first["credits"] == 250 and first["scope"] == "total"
    assert first["image_daily"] == [{"name": "Nano", "used": 3, "limit": 1000}]
    client.get("/api/usage")
    client.get("/api/usage")
    assert fake.usage_calls == 1  # the short cache absorbs bursts
    assert client.get("/api/usage", headers={"X-User": ""}).status_code == 401


def test_status_codes_are_formatted_by_this_app(env):
    client, fake, _ = env
    fake.status_chunks = [
        {"status": {"code": "queued", "params": {"active": 4, "position": 2}}, "choices": [{"delta": {"reasoning_content": "⏳ legacy text\n"}}]},
        {"status": {"code": "captcha_submit", "params": {}}, "choices": [{"delta": {"reasoning_content": "正在进行打码验证并提交图片生成请求...\n"}}]},
        {"status": {"code": "progress", "params": {"percent": 40}}, "choices": [{"delta": {"reasoning_content": "生成进度: 约 40%\n"}}]},
    ]
    seen = []
    orig = client.app.state.runner._progress

    async def spy(job_id, text):
        seen.append(text)
        await orig(job_id, text)

    client.app.state.runner._progress = spy
    job = wait_job(client, client.post("/api/jobs", json={"model": "gemini-3.1-flash-image", "prompt": "x"}).json()["jobs"][0])
    assert job["status"] == "done"
    assert "排队中 第 2 位" in seen
    assert "生成中 40%" in seen
    assert "生成中" in seen                  # captcha detail is not shown
    assert not any("legacy" in t or "打码" in t for t in seen)


def test_error_status_code_fails_the_job(env):
    client, fake, _ = env
    fake.status_chunks = [{"status": {"code": "error", "params": {"message": "没有可用的Token"}}, "choices": [{"delta": {"reasoning_content": "错误: 没有可用的Token\n"}}]}]
    fake.no_result = True
    job = wait_job(client, client.post("/api/jobs", json={"model": "gemini-3.1-flash-image", "prompt": "x"}).json()["jobs"][0])
    assert job["status"] == "failed" and "没有可用的Token" in job["error"]


def test_users_have_uuid_unique_names_and_editable_profile(env):
    client, _, _ = env
    me = client.get("/api/me").json()
    assert len(me["id"]) == 32 and me["name"] == "小明" and me["avatar"] == ""
    assert client.post("/api/users", json={"name": "小明"}).status_code == 409
    assert client.post("/api/users", json={"name": "bad/name"}).status_code == 400
    listed = {u["name"]: u for u in client.get("/api/users", headers={"X-User": ""}).json()["users"]}
    assert set(listed) == {"小明", "小红"} and listed["小明"]["id"] == me["id"]
    # rename keeps the id (and the boards under it); taken names are refused
    bid = client.post("/api/boards", json={"name": "a"}).json()["id"]
    assert client.put("/api/me", json={"name": "小红"}).status_code == 409
    assert client.put("/api/me", json={"name": "阿明"}).json()["name"] == "阿明"
    assert client.get(f"/api/boards/{bid}").status_code == 200
    # avatars: emoji, uploaded image, or nothing; anything else is refused
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
