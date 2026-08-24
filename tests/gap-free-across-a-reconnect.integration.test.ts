import { beforeEach, expect, test } from "vitest";

import { framesOf, type Frames } from "../packages/next-sse/src/server/frames.testkit.js";
import { asType, initSSE } from "../packages/next-sse/src/server/index.js";
import type { Cursor } from "../packages/next-sse/src/transport/index.js";
import { createMemoryTransport } from "../packages/next-sse/src/transport/memory.js";

/**
 * The library's core guarantee, exercised whole on the Memory Transport: a client loses its
 * Connection, Messages are Published while it is away, it reconnects with its Cursor, and every
 * Message it missed reaches it exactly once per Channel.
 *
 * Nothing is mocked here. It is the real route handler answering real `Request`s, the real
 * Instance replaying out of the real log, and the frames are read off the response body the way
 * a browser reads them — the whole path a Connection takes, minus Next.js itself, which is what
 * the e2e suite adds on top.
 */

interface ChatHandle {
  message(payload: unknown): Promise<Cursor>;
}

interface ChatApp {
  handlers: { GET: (request: Request) => Promise<Response> };
  chat(params?: Record<string, string>): ChatHandle;
}

/** The two Channels of this App, which is what makes "per Channel" mean anything. */
const ROOMS = ["42", "7"];

beforeEach(() => {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  delete globals[Symbol.for("@flefebvre/next-sse")];
});

const anApp = (): ChatApp => {
  const { channel, createSSE } = initSSE({ transport: createMemoryTransport() });

  return createSSE({
    chat: channel({ pattern: "chat:{roomId}", events: { message: asType<{ text: string }>() } }),
  }) as unknown as ChatApp;
};

/** One open Connection: the frames it is being written, and the way its client goes away. */
interface Client {
  frames: Frames;
  /** The Cursor the Instance settled this Connection on, out of its `ready` event. */
  cursor: Cursor;
  /** The client goes away the way a browser does when its tab closes. */
  leave: () => void;
}

/**
 * Open a Connection on both Channels, resuming from `after` when there is one, and read its
 * opening sequence: `ready`, the retry, and — for a Connection with nothing to replay —
 * `caught-up`. The Cursor travels in `Last-Event-ID`, which is what a browser's own reconnect
 * sends and what wins over the query (ADR-0004).
 */
async function connect(sse: ChatApp, after?: Cursor, expectCaughtUp = true): Promise<Client> {
  const query = ROOMS.map((room) => `channel=chat:${room}`).join("&");
  const client = new AbortController();
  const response = await sse.handlers.GET(
    new Request(`http://example.test/api/sse?${query}`, {
      signal: client.signal,
      headers: after === undefined ? undefined : { "Last-Event-ID": after },
    }),
  );
  expect(response.status).toBe(200);

  const frames = framesOf(response);
  const ready = await frames.next();
  expect(ready.event).toBe("ready");
  expect(ready.id).toBeUndefined();
  expect(await frames.next()).toEqual({ retry: "3000" });
  if (expectCaughtUp) expect((await frames.next()).event).toBe("caught-up");

  return {
    frames,
    cursor: (JSON.parse(ready.data ?? "{}") as { cursor: Cursor }).cursor,
    leave: () => {
      client.abort();
    },
  };
}

/** What a Message frame carries, as the client reads it: its Channel, its text, and its id. */
interface Received {
  channel: string;
  text: string;
  cursor: string;
}

/** Read the next `count` Messages, refusing anything that is not one. */
async function receive(client: Client, count: number): Promise<Received[]> {
  const received: Received[] = [];
  while (received.length < count) {
    const frame = await client.frames.next();
    if (frame.event !== undefined) {
      throw new Error(`a Control event arrived among the Messages: ${frame.event}`);
    }
    const { channel, payload } = JSON.parse(frame.data ?? "{}") as {
      channel: string;
      payload: { text: string };
    };
    received.push({ channel, text: payload.text, cursor: frame.id ?? "" });
  }

  return received;
}

/** What one Channel got, in order, out of everything a client received. */
const on = (received: Received[], room: string): string[] =>
  received.filter((one) => one.channel === `chat:${room}`).map((one) => one.text);

/** Publish `count` Messages, alternating Channels, so both are interleaved in the one log. */
async function publish(sse: ChatApp, count: number, label: string): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    const room = ROOMS[n % ROOMS.length] as string;
    await sse.chat({ roomId: room }).message({ text: `${label}-${String(n)}` });
  }
}

/**
 * The texts one of the two Channels was Published, in order: `publish` alternates, so each
 * Channel got every other one of them.
 */
const alternating = (label: string, at: number): string[] =>
  Array.from({ length: 10 }, (_, n) => `${label}-${String(n * 2 + at)}`);

test("a Connection that drops and resumes from its Cursor misses nothing and repeats nothing", async () => {
  const sse = anApp();
  const first = await connect(sse);

  await publish(sse, 4, "before");
  const live = await receive(first, 4);
  first.leave();

  await publish(sse, 20, "away");

  const second = await connect(sse, live[3]?.cursor, false);
  const replayed = await receive(second, 20);
  expect((await second.frames.next()).event).toBe("caught-up");

  await publish(sse, 2, "after");
  const afterwards = await receive(second, 2);

  expect(on(replayed, "42")).toEqual(alternating("away", 0));
  expect(on(replayed, "7")).toEqual(alternating("away", 1));
  expect(on(afterwards, "42")).toEqual(["after-0"]);
  expect(on(afterwards, "7")).toEqual(["after-1"]);
  expect(new Set(replayed.map((one) => one.cursor)).size).toBe(20);
  expect(replayed.map((one) => one.text)).not.toContain("before-3");

  second.leave();
});

/**
 * ADR-0004's live-only connect, end to end: this client never received a Message, so the only
 * position it has is the tail the Instance adopted for it and put in `ready`. Carrying it is
 * what keeps the reconnect window from swallowing a Message on a Channel that had been quiet.
 */
test("a Connection that never received a Message still resumes from the tail it adopted", async () => {
  const sse = anApp();
  await publish(sse, 2, "long before");
  const first = await connect(sse);
  first.leave();

  await publish(sse, 2, "away");
  const second = await connect(sse, first.cursor, false);
  const replayed = await receive(second, 2);
  expect((await second.frames.next()).event).toBe("caught-up");

  expect(on(replayed, "42")).toEqual(["away-0"]);
  expect(on(replayed, "7")).toEqual(["away-1"]);

  second.leave();
});

/**
 * The Cursor is gone, and the answer is still a `200` stream: a `reset` in band, a fresh Cursor
 * in `ready`, and the Connection carries on live. A non-200 would be retried by the client core
 * with the same URL forever (ADR-0006).
 */
test("a Connection whose Cursor the log has dropped is reset in band, and goes on live", async () => {
  const { channel, createSSE } = initSSE({
    transport: createMemoryTransport({ retention: { cap: 4 } }),
  });
  const sse = createSSE({
    chat: channel({ pattern: "chat:{roomId}", events: { message: asType<{ text: string }>() } }),
  }) as unknown as ChatApp;

  const first = await connect(sse);
  await publish(sse, 2, "before");
  const seen = await receive(first, 2);
  first.leave();

  await publish(sse, 20, "away");
  const second = await connect(sse, seen[0]?.cursor, false);

  expect((await second.frames.next()).event).toBe("reset");
  expect((await second.frames.next()).event).toBe("caught-up");
  expect(second.cursor).not.toBe(seen[0]?.cursor);

  await publish(sse, 2, "after");
  const afterwards = await receive(second, 2);

  expect(on(afterwards, "42")).toEqual(["after-0"]);
  expect(on(afterwards, "7")).toEqual(["after-1"]);

  second.leave();
});
