"""Stale-tab saves, jobs surviving a restart, upload limits."""
from fastapi.testclient import TestClient

from fake_gateway import FakeGateway, make_app, paid_user, png, wait_job


def test_stale_tab_cannot_overwrite_a_newer_save(tmp_path):
    app, _ = make_app(tmp_path)
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "小明")
        bid = client.post("/api/boards", json={"name": "b"}).json()["id"]
        rev0 = client.get(f"/api/boards/{bid}").json()["rev"]
        first = client.put(f"/api/boards/{bid}", json={"data": {"nodes": [{"id": "a"}]}, "base_rev": rev0}).json()
        assert first["rev"] == rev0 + 1
        # a second tab that still holds rev0 is refused and its data is not stored
        stale = client.put(f"/api/boards/{bid}", json={"data": {"nodes": [{"id": "b"}]}, "base_rev": rev0})
        assert stale.status_code == 409
        assert client.get(f"/api/boards/{bid}").json()["data"]["nodes"] == [{"id": "a"}]
        # renaming does not count as a data change; saving with the current revision works
        assert client.put(f"/api/boards/{bid}", json={"name": "新名字"}).status_code == 200
        ok = client.put(f"/api/boards/{bid}", json={"data": {"nodes": []}, "base_rev": first["rev"]})
        assert ok.status_code == 200 and ok.json()["rev"] == first["rev"] + 1
        assert client.put("/api/boards/nope", json={"data": {}, "base_rev": 0}).status_code == 404


def test_board_list_thumbs_follow_saved_images(tmp_path):
    app, _ = make_app(tmp_path)
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "小明")
        asset = client.post("/api/assets", content=png()).json()["id"]
        bid = client.post("/api/boards", json={"name": "b"}).json()["id"]
        node = {"id": "i", "type": "image", "data": {"assetId": asset}}
        client.put(f"/api/boards/{bid}", json={"data": {"nodes": [node]}})
        assert client.get("/api/boards").json()["boards"][0]["thumbs"] == [asset]


def _unfinished_job(app, uid, with_task):
    cloud = {"kind": "image", "provider": "flow", "model": "Nano Banana 2.1", "ratio": "16:9", "resolution": "1K", "quality": "", "refs": []}
    extra = {"cloud": cloud, **({"cloud_task": "t1"} if with_task else {})}
    app.state.store.create_job({"id": "a" * 16, "user": uid, "model": "cloud:flow:Nano Banana 2.1", "prompt": "p", "extra": extra})
    app.state.store.update_job("a" * 16, status="running", started=1.0)


def test_job_with_a_gateway_task_resumes_after_restart(tmp_path):
    app, fake = make_app(tmp_path)
    uid = app.state.store.create_user("小明")["id"]
    fake.kinds["t1"] = "image"
    _unfinished_job(app, uid, True)
    with TestClient(app) as client:
        client.headers["X-User"] = uid
        job = wait_job(client, "a" * 16)
        assert job["status"] == "done" and job["result_asset"]
    assert fake.submitted == []          # nothing was submitted a second time


def test_job_that_never_reached_the_gateway_fails_after_restart(tmp_path):
    app, fake = make_app(tmp_path)
    uid = app.state.store.create_user("小明")["id"]
    _unfinished_job(app, uid, False)
    with TestClient(app):
        pass
    job = app.state.store.get_job("a" * 16)
    assert job["status"] == "failed" and "中断" in job["error"]


def test_shutdown_leaves_running_jobs_for_the_next_start(tmp_path):
    fake = FakeGateway()
    fake.hold = True
    app, _ = make_app(tmp_path, fake)
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "小明")
        job_id = client.post("/api/jobs", json={"model": "flow:Nano Banana 2.1", "prompt": "x"}).json()["jobs"][0]
        for _ in range(100):
            if app.state.store.get_job(job_id)["extra"].get("cloud_task"):
                break
            import time
            time.sleep(0.05)
    job = app.state.store.get_job(job_id)
    assert job["status"] == "running" and fake.cancelled == []      # not cancelled by the shutdown
    fake.hold = False
    app2, _ = make_app(tmp_path, fake)
    with TestClient(app2) as client:
        client.headers["X-User"] = job["user"]
        assert wait_job(client, job_id)["status"] == "done"


def test_oversized_upload_is_refused(tmp_path):
    app, _ = make_app(tmp_path, max_upload_bytes=1000)
    with TestClient(app) as client:
        client.headers["X-User"] = paid_user(app, client, "小明")
        res = client.post("/api/assets", content=b"x" * 5000)
        assert res.status_code == 400 and "太大" in res.json()["error"]
