import { expect, test } from "vitest";

import { startInstance } from "./harness/example.js";
import { openStream } from "./harness/stream.js";

/**
 * Per-Channel refusal end to end, on the built example app: a reader with no session asks for
 * the room and for the admin Channel, and is given one of them.
 *
 * The refusal travels on a `200`, in `ready`, because that is the only thing a browser
 * `EventSource` can see (ADR-0003) — and the Connection carries on: the room streams a Message
 * published from an ordinary Route Handler while the admin Channel is refused on the same wire.
 */
test("a refused Channel is dropped while the others stream", async () => {
  const instance = await startInstance();
  const stream = openStream(`${instance.url}/api/sse?channel=chat:42&channel=admin`);

  try {
    const ready = await stream.next("ready");
    expect(JSON.parse(ready.data)).toEqual({
      cursor: expect.any(String),
      refused: ["admin"],
      heartbeat: 15_000,
    });

    await stream.next("caught-up");

    await publish(instance.url, "the room is not refused");

    /**
     * What the envelope looks like is the Publish scenario's claim; this one asks only that the
     * Channel which passed Authorize is still carrying its Messages on a Connection that had one
     * refused.
     */
    const { channel, payload } = JSON.parse((await stream.next("message")).data) as Envelope;
    expect(channel).toBe("chat:42");
    expect(payload.text).toBe("the room is not refused");

    await expectTheAdminChannelAlone(instance.url);
  } finally {
    stream.close();
    await instance.stop();
  }
});

/** As much of a Message as this scenario reads. */
interface Envelope {
  channel: string;
  payload: { text: string };
}

/** One Message into the room, through the demo's own webhook. */
async function publish(url: string, text: string): Promise<void> {
  const published = await fetch(`${url}/api/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  expect(published.status).toBe(200);
}

/**
 * The same reader asking for nothing but the Channel it may not have: still a `200`, still
 * `ready` naming the refusal — and then the end of the stream, with no Cursor to resume from and
 * no `retry:` inviting a browser to come back for the same answer. Read with `fetch` rather than
 * an `EventSource`, which would reconnect forever and never show the body ending.
 */
async function expectTheAdminChannelAlone(url: string): Promise<void> {
  const response = await fetch(`${url}/api/sse?channel=admin`);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(await response.text()).toBe('event: ready\ndata: {"refused":["admin"]}\n\n');
}
