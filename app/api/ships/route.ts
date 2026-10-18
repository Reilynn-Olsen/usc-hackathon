const encoder = new TextEncoder();
const boundingBoxes = [[[33.55, -118.5], [33.9, -118.1]]];

export async function GET(request: Request) {
  const apiKey = process.env.AISSTREAM_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "AISSTREAM_API_KEY is not configured." }, { status: 503 });
  }
  if (typeof WebSocket === "undefined") {
    return Response.json({ error: "The server runtime must support WebSocket." }, { status: 503 });
  }

  // shortcut: one upstream socket per client, fine for a demo; use shared fanout for many viewers.
  const socket = new WebSocket("wss://stream.aisstream.io/v0/stream");
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const finish = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      const abort = () => {
        finish();
        socket.close();
      };
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) { abort(); return; }
      controller.enqueue(encoder.encode(": connected\n\n"));
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          APIKey: apiKey,
          BoundingBoxes: boundingBoxes,
          FilterMessageTypes: ["PositionReport"],
        }));
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message && typeof message === "object" && ("error" in message || "Error" in message)) {
            send("provider-error", { error: "AISStream rejected the subscription." });
            finish();
            socket.close();
            return;
          }
          send("vessel", message);
        } catch {
          send("provider-error", { error: "AISStream sent an invalid message." });
        }
      });
      socket.addEventListener("error", () => {
        send("provider-error", { error: "AISStream connection failed." });
        finish();
      });
      socket.addEventListener("close", finish);

    },
    cancel() {
      closed = true;
      socket.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
