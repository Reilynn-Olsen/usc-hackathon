import assert from "node:assert/strict";
import test from "node:test";
import { GET as getWeather } from "../app/api/weather/route.ts";
import { GET as getShips } from "../app/api/ships/route.ts";

test("weather route requests hourly weather and marine data for Los Angeles", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input) => {
    urls.push(new URL(String(input)));
    return Response.json({ hourly: { time: [] } });
  };

  try {
    const response = await getWeather();
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.location.name, "Port of Los Angeles");
    assert.equal(urls.length, 2);
    assert.ok(urls.some((url) => url.hostname === "api.open-meteo.com" && url.searchParams.get("hourly").includes("wind_gusts_10m")));
    assert.ok(urls.some((url) => url.hostname === "marine-api.open-meteo.com" && url.searchParams.get("hourly").includes("wave_height")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ships route keeps the AIS key server-side and forwards position reports as SSE", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalKey = process.env.AISSTREAM_API_KEY;

  class FakeWebSocket {
    static instance;
    listeners = new Map();
    constructor(url) {
      this.url = url;
      FakeWebSocket.instance = this;
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    emit(type, event = {}) {
      this.listeners.get(type)?.(event);
    }
    send(message) {
      this.subscription = JSON.parse(message);
    }
    close() {
      this.emit("close");
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  process.env.AISSTREAM_API_KEY = "test-secret";
  try {
    const response = await getShips(new Request("http://localhost/api/ships"));
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = response.body.getReader();
    await reader.read();

    const socket = FakeWebSocket.instance;
    socket.emit("open");
    assert.equal(socket.subscription.APIKey, "test-secret");
    assert.deepEqual(socket.subscription.FilterMessageTypes, ["PositionReport"]);
    socket.emit("message", { data: JSON.stringify({ MessageType: "PositionReport", MetaData: { MMSI: 123 } }) });

    const event = new TextDecoder().decode((await reader.read()).value);
    assert.match(event, /event: vessel/);
    assert.match(event, /"MMSI":123/);
    assert.ok(!event.includes("test-secret"));
    await reader.cancel();
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
    if (originalKey === undefined) delete process.env.AISSTREAM_API_KEY;
    else process.env.AISSTREAM_API_KEY = originalKey;
  }
});
