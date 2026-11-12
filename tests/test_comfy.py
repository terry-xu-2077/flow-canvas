import asyncio
import json

import httpx
from fastapi.testclient import TestClient

from server.app import create_app, resolve_size
from server.comfy import ComfyClient, ComfyError
from server.comfy_workflows import UPSCALERS
from server.config import Settings
from server.flow import FlowClient

from test_api import BASE, FakeFlow


def test_resolve_size_routes():
    s = Settings(comfy_url="http://c")
    assert resolve_size(s, ["1K", "2K"], "2K") == ("2K", None)
    assert resolve_size(s, ["1K", "2K"], "4K") == ("2K", 4096)
    assert resolve_size(s, ["1K", "2K"], "6K") == ("2K", 6144)
    assert resolve_size(s, ["1K"], "6K") == ("1K", 6144)          # base missing on the model: falls back to its smallest
    assert resolve_size(Settings(), ["1K", "2K"], "4K") is None    # ComfyUI not configured
    s.resolutions["2K"] = {"route": "comfy", "base": "1K", "target": 2752}
    assert resolve_size(s, ["1K", "2K"], "2K") == ("1K", 2752)
    s.disabled_sizes = ("4K",)
    assert resolve_size(s, ["1K", "2K"], "4K") is None


def test_workflows_are_wired_consistently():
    for name, (_label, build) in UPSCALERS.items():
        prompt, out = build("in.png", 2752, 1536, 4096, {}, "")
        assert prompt[out]["class_type"] == "SaveImage"
        for nid, node in prompt.items():
            for v in node["inputs"].values():
                if isinstance(v, list):
                    assert v[0] in prompt, (name, nid, v)
    prompt, _ = UPSCALERS["seedvr2"][1]("in.png", 2752, 1536, 6144, {}, "")
    assert prompt["10"]["inputs"]["resize_type.multiplier"] == 2.233
    prompt, _ = UPSCALERS["pid"][1]("in.png", 2752, 1536, 4096, {}, "x")
    assert (prompt["12"]["inputs"]["width"], prompt["12"]["inputs"]["height"]) == (4096, 2304)


def test_comfy_client_runs_a_workflow():
    seen = {}

    def handle(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path == "/upload/image":
            return httpx.Response(200, json={"name": "a.png", "subfolder": "", "type": "input"})
        if path == "/prompt":
            seen["prompt"] = json.loads(req.content)["prompt"]
            return httpx.Response(200, json={"prompt_id": "p1"})
        if path == "/history/p1":
            if seen.get("polled"):
                return httpx.Response(200, json={"p1": {"status": {"status_str": "success", "completed": True},
                                                          "outputs": {"9": {"images": [{"filename": "o.png", "subfolder": "", "type": "output"}]}}}})
            seen["polled"] = True
            return httpx.Response(200, json={})
        if path == "/queue":
            return httpx.Response(200, json={"queue_running": [], "queue_pending": [[1, "p1", {}]]})
        if path == "/view":
            return httpx.Response(200, content=b"PNGDATA")
        return httpx.Response(404)

    async def go():
        c = ComfyClient("http://comfy", transport=httpx.MockTransport(handle), poll=0.01)
        notes: list[str] = []

        async def note(t):
            notes.append(t)
        name = await c.upload_image(b"x", "a.png")
        data = await c.run_image({"9": {"class_type": "SaveImage", "inputs": {}}}, "9", note)
        await c.close()
        return name, data, notes

    name, data, notes = asyncio.run(go())
    assert name == "a.png" and data == b"PNGDATA" and notes and "排队" in notes[0]


def test_comfy_rejection_is_readable():
    def handle(req):
        return httpx.Response(400, json={"error": {"message": "Prompt outputs failed validation"},
                                         "node_errors": {"13": {"class_type": "UNETLoader", "errors": [
                                             {"message": "Value not in list", "details": "unet_name: 'x'"}]}}})
    async def go():
        c = ComfyClient("http://comfy", transport=httpx.MockTransport(handle))
        await c.queue({})
    try:
        asyncio.run(go())
    except ComfyError as exc:
        assert "UNETLoader" in str(exc) and "unet_name" in str(exc)
    else:
        raise AssertionError("expected ComfyError")


def test_models_offer_comfy_sizes_and_jobs_carry_the_upscale(tmp_path):
    fake = FakeFlow()
    settings = Settings(flow_base_url=BASE, flow_api_key="k", data_dir=tmp_path / "data", comfy_url="http://comfy")
    flow = FlowClient(BASE, "k", transport=httpx.MockTransport(fake.handle))
    with TestClient(create_app(settings, flow)) as client:
        client.headers["X-User"] = client.post("/api/users", json={"name": "小明"}).json()["id"]
        m = client.get("/api/models").json()
        assert m["models"][0]["sizes"] == ["1K", "2K", "4K", "6K"]
        assert m["upscale"] == {"enabled": True, "label": "4K", "target": 4096}
        assert client.post("/api/upscale", json={"asset": "0" * 40}).status_code == 400   # unknown image
