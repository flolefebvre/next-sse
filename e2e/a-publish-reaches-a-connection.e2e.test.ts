import { expect, test } from "vitest";

import { startInstance } from "./harness/example.js";
import { openStream } from "./harness/stream.js";

/**
 * The wire, end to end: a client opens a Connection on a running Instance of the built example
 * app, the app Publishes through a bound Handle from an ordinary Route Handler, and the Message
 * comes out of the stream as an unnamed block carrying its Channel, the event name the Registry
 * declared, and the payload.
 */
test("a Publish reaches a Connection", async () => {
  const instance = await startInstance();
  const url = `${instance.url}/api/sse?channel=chat:42`;
  const stream = openStream(url);

  try {
    const ready = await stream.next("ready");
    expect(JSON.parse(ready.data)).toEqual({ cursor: expect.any(String), refused: [] });
    expect(ready.lastEventId).toBe("");

    await stream.next("caught-up");

    await expectStreamHeaders(url);

    const published = await fetch(`${instance.url}/api/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello from a Route Handler" }),
    });
    expect(published.status).toBe(200);

    const message = await stream.next("message");
    expect(JSON.parse(message.data)).toEqual({
      channel: "chat:42",
      event: "message",
      payload: { id: expect.any(String), text: "hello from a Route Handler" },
    });
    expect(message.lastEventId).not.toBe("");
  } finally {
    stream.close();
    await instance.stop();
  }
});

/**
 * What `EventSource` cannot show, because it exposes no response: the headers ADR-0004 requires
 * of the stream, read off the same endpoint with a Connection opened and dropped at once.
 */
async function expectStreamHeaders(url: string): Promise<void> {
  const client = new AbortController();

  try {
    const response = await fetch(url, { signal: client.signal });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("content-encoding")).toBe(null);
  } finally {
    client.abort();
  }
}
