import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/api/ships/route.ts";

class FakeSocket extends EventTarget {
  static latest;
  constructor() {
    super();
    FakeSocket.latest = this;
  }
  send(data) {
    this.subscription = JSON.parse(data);
  }
  close() {
    this.closed = true;
  }
}

async function withSocket(callback) {
  const original = globalThis.WebSocket;
  const key = process.env.AISSTREAM_API_KEY;
  globalThis.WebSocket = FakeSocket;
  process.env.AISSTREAM_API_KEY = "test-key";
  try {
    await callback();
  } finally {
    globalThis.WebSocket = original;
    if (key === undefined) delete process.env.AISSTREAM_API_KEY;
    else process.env.AISSTREAM_API_KEY = key;
  }
}

const decode = (chunk) => new TextDecoder().decode(chunk.value);

test("AIS stream forwards positions and closes its upstream socket on client cancellation", async () => {
  await withSocket(async () => {
    const response = await GET(new Request("http://localhost/api/ships"));
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const socket = FakeSocket.latest;
    const reader = response.body.getReader();
    await reader.read();
    socket.dispatchEvent(new Event("open"));
    assert.equal(socket.subscription.APIKey, "test-key");
    const data = JSON.stringify({
      MetaData: { MMSI: 338123001 },
      Message: { PositionReport: { Latitude: 33.7, Longitude: -118.4 } },
    });
    socket.dispatchEvent(new MessageEvent("message", { data }));
    const event = decode(await reader.read());
    assert.match(event, /event: vessel/);
    assert.ok(event.includes(data));
    await reader.cancel();
    assert.equal(socket.closed, true);
  });
});

test("AIS provider rejection is surfaced without leaking credentials and closes resources", async () => {
  await withSocket(async () => {
    const response = await GET(new Request("http://localhost/api/ships"));
    const socket = FakeSocket.latest;
    const reader = response.body.getReader();
    await reader.read();
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ error: "Rejected test-key" }),
      }),
    );
    const event = decode(await reader.read());
    assert.match(event, /event: provider-error/);
    assert.equal(event.includes("test-key"), false);
    assert.equal((await reader.read()).done, true);
    assert.equal(socket.closed, true);
  });
});

test("aborting the request closes the AIS socket and response stream", async () => {
  await withSocket(async () => {
    const controller = new AbortController();
    const response = await GET(
      new Request("http://localhost/api/ships", { signal: controller.signal }),
    );
    const socket = FakeSocket.latest;
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    assert.equal(socket.closed, true);
    assert.equal((await reader.read()).done, true);
  });
});
