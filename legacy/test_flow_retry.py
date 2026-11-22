import asyncio

import httpx

from server import flow
from server.flow import FlowClient


def test_generate_retries_after_dropped_stream(monkeypatch):
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.RemoteProtocolError("peer closed connection")
        body = 'data: {"choices":[{"delta":{"content":"![x](http://h/a.png)"}}]}\n\ndata: [DONE]\n\n'
        return httpx.Response(200, content=body.encode())

    async def no_sleep(_):
        return None

    monkeypatch.setattr(flow.asyncio, "sleep", no_sleep)

    async def run():
        c = FlowClient("http://f", "k", transport=httpx.MockTransport(handler))
        try:
            return await c.generate("m", "p", [])
        finally:
            await c.close()

    assert asyncio.run(run()) == "http://h/a.png"
    assert calls["n"] == 2


def test_retry_reuses_request_id(monkeypatch):
    ids = []

    def handler(req: httpx.Request) -> httpx.Response:
        ids.append(req.headers.get("x-request-id"))
        if len(ids) == 1:
            raise httpx.RemoteProtocolError("peer closed connection")
        return httpx.Response(200, content=b'data: {"choices":[{"delta":{"content":"![x](http://h/a.png)"}}]}\n\ndata: [DONE]\n\n')

    async def no_sleep(_):
        return None

    monkeypatch.setattr(flow.asyncio, "sleep", no_sleep)

    async def run():
        c = FlowClient("http://f", "k", transport=httpx.MockTransport(handler))
        try:
            return await c.generate("m", "p", [])
        finally:
            await c.close()

    asyncio.run(run())
    assert len(ids) == 2 and ids[0] and ids[0] == ids[1]


def test_keeps_retrying_through_gateway_errors(monkeypatch):
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(1)
        if len(seen) <= 5:  # longer than the old fixed retry count
            return httpx.Response(502, text="bad gateway")
        return httpx.Response(200, content=b'data: {"choices":[{"delta":{"content":"![x](http://h/a.png)"}}]}\n\ndata: [DONE]\n\n')

    async def no_sleep(_):
        return None

    monkeypatch.setattr(flow.asyncio, "sleep", no_sleep)

    async def run():
        c = FlowClient("http://f", "k", transport=httpx.MockTransport(handler))
        try:
            return await c.generate("m", "p", [])
        finally:
            await c.close()

    assert asyncio.run(run()) == "http://h/a.png"
