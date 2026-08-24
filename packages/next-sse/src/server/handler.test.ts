import { getEventListeners } from "node:events";

import { beforeEach, expect, test } from "vitest";

import type { Cursor } from "../transport/index.js";
import { createMemoryTransport } from "../transport/memory.js";

import { framesOf, type Frames } from "./frames.testkit.js";
import { asType, initSSE } from "./index.js";
import { getInstance } from "./instance.js";

beforeEach(() => {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  delete globals[Symbol.for("@flefebvre/next-sse")];
});

/**
 * The App of these tests: one Channel with one declared event. The Registry is loosely typed
 * until the typing ticket infers it, so the tests name the shape they expect of it — which is
 * the runtime shape the final types will describe.
 */
interface ChatHandle {
  publish(event: string, payload: unknown): Promise<Cursor>;
  message(payload: unknown): Promise<Cursor>;
}

interface ChatApp {
  handlers: { GET: (request: Request) => Promise<Response> };
  chat(params?: Record<string, string>): ChatHandle;
}

const appWith = (transport = createMemoryTransport()): ChatApp => {
  const { channel, createSSE } = initSSE({ transport });

  return createSSE({
    chat: channel({
      pattern: "chat:{roomId}",
      events: { message: asType<{ text: string }>(), typing: asType<{ who: string }>() },
    }),
  }) as unknown as ChatApp;
};

const connect = async (sse: ChatApp, query: string, init?: RequestInit): Promise<Response> =>
  sse.handlers.GET(new Request(`http://example.test/api/sse${query}`, init));

/**
 * A Connection past its opening sequence, which is where every test about the live feed starts.
 */
const liveConnection = async (sse: ChatApp, query: string): Promise<Frames> => {
  const frames = framesOf(await connect(sse, query));
  await frames.next();
  await frames.next();
  await frames.next();

  return frames;
};

test("a Connection that names no Channel is refused before anything is opened", async () => {
  const sse = appWith();

  const response = await connect(sse, "");

  expect(response.status).toBe(400);
  expect(getInstance().connections.size).toBe(0);
});

test("a Channel with no name is no Channel at all", async () => {
  const sse = appWith();

  expect((await connect(sse, "?channel=")).status).toBe(400);
  expect(getInstance().connections.size).toBe(0);
});

test("an empty Channel among named ones is dropped, and the rest are honoured", async () => {
  const transport = createMemoryTransport();
  const sse = appWith(transport);
  const frames = await liveConnection(sse, "?channel=&channel=chat:42");

  const cursor = await sse.chat({ roomId: "42" }).message({ text: "hello" });

  expect((await frames.next()).id).toBe(cursor);
  await frames.cancel();
});

test("the stream carries exactly the headers of ADR-0004", async () => {
  const sse = appWith();

  const response = await connect(sse, "?channel=chat:42");

  expect(response.status).toBe(200);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => (headers[name] = value));

  expect(headers).toEqual({
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  });
  await framesOf(response).cancel();
});

test("the stream opens on ready, then retry, then caught-up", async () => {
  const transport = createMemoryTransport();
  const sse = appWith(transport);
  const tail = await transport.tail();

  const frames = framesOf(await connect(sse, "?channel=chat:42"));

  expect(await frames.next()).toEqual({
    event: "ready",
    data: JSON.stringify({ cursor: tail, refused: [] }),
  });
  expect(await frames.next()).toEqual({ retry: "3000" });
  expect(await frames.next()).toEqual({ event: "caught-up", data: "{}" });
  await frames.cancel();
});

test("a Message arrives as an unnamed block: its Cursor as the id, the envelope as the data", async () => {
  const transport = createMemoryTransport();
  const sse = appWith(transport);
  const frames = await liveConnection(sse, "?channel=chat:42");

  const cursor = await sse.chat({ roomId: "42" }).message({ text: "hello" });

  expect(await frames.next()).toEqual({
    id: cursor,
    data: JSON.stringify({ channel: "chat:42", event: "message", payload: { text: "hello" } }),
  });
  await frames.cancel();
});

test("a Connection is fed only the Channels it named", async () => {
  const transport = createMemoryTransport();
  const sse = appWith(transport);
  const frames = await liveConnection(sse, "?channel=chat:42");

  await sse.chat({ roomId: "7" }).message({ text: "elsewhere" });
  const cursor = await sse.chat({ roomId: "42" }).message({ text: "here" });

  expect((await frames.next()).id).toBe(cursor);
  await frames.cancel();
});

test("a Connection may name several Channels", async () => {
  const transport = createMemoryTransport();
  const sse = appWith(transport);
  const frames = await liveConnection(sse, "?channel=chat:42&channel=chat:7");

  await sse.chat({ roomId: "7" }).message({ text: "seven" });

  expect((await frames.next()).data).toBe(
    JSON.stringify({ channel: "chat:7", event: "message", payload: { text: "seven" } }),
  );
  await frames.cancel();
});

test("a client that goes away leaves no Connection behind and no listener on the request", async () => {
  const sse = appWith();
  const client = new AbortController();
  const response = await connect(sse, "?channel=chat:42", { signal: client.signal });
  const frames = framesOf(response);
  await frames.next();

  expect(getInstance().connections.size).toBe(1);
  client.abort();

  expect(getInstance().connections.size).toBe(0);
  expect(getEventListeners(client.signal, "abort")).toHaveLength(0);
});

test("a cancelled stream leaves no Connection behind either", async () => {
  const sse = appWith();
  const frames = framesOf(await connect(sse, "?channel=chat:42"));
  await frames.next();

  await frames.cancel();

  expect(getInstance().connections.size).toBe(0);
});

/**
 * `publish` takes the event name as data, for a call site that only learns it at runtime. It
 * is still one of the Channel's declared events: an event with no schema has no payload type
 * and nothing to validate against, so there is nothing honest to put on the wire.
 */
test("a Handle publishes on the declared event name, and on a dynamic one", async () => {
  const transport = createMemoryTransport();
  const sse = appWith(transport);

  await sse.chat({ roomId: "42" }).message({ text: "declared" });
  await sse.chat({ roomId: "42" }).publish("typing", { who: "ada" });

  const page = await transport.read(undefined, 100);
  if ("gone" in page) throw new Error("the log answered gone");

  const published = page.entries
    .filter((entry) => entry.type === "message")
    .map((entry) => `${entry.channel}/${entry.event}`);

  expect(published).toEqual(["chat:42/message", "chat:42/typing"]);
});

test("a Handle missing a param of its pattern is an error, not a Channel with a brace in it", () => {
  const sse = appWith();

  expect(() => sse.chat()).toThrow(/roomId/);
});

test("a re-evaluated Registry publishes into the log the open Connections are reading", async () => {
  const sse = appWith();
  const frames = await liveConnection(sse, "?channel=chat:42");

  const reevaluated = appWith(createMemoryTransport());
  const cursor = await reevaluated.chat({ roomId: "42" }).message({ text: "after the edit" });

  expect(await frames.next()).toEqual({
    id: cursor,
    data: JSON.stringify({
      channel: "chat:42",
      event: "message",
      payload: { text: "after the edit" },
    }),
  });
  await frames.cancel();
});

/**
 * The whole gap-free sequence on the wire: the Cursor it asked for in `ready`, the retry, the
 * one Message it missed, `caught-up`, and then the live feed — with nothing repeated at the
 * seam between the replay and the feed.
 */
test("a Connection that brings a Cursor opens on it, is replayed what it missed, then caught up", async () => {
  const transport = createMemoryTransport();
  const sse = appWith(transport);
  const chat = sse.chat({ roomId: "42" });
  const from = await chat.message({ text: "the last it saw" });
  const missed = await chat.message({ text: "missed" });

  const frames = framesOf(await connect(sse, `?channel=chat:42&cursor=${from}`));

  expect(await frames.next()).toEqual({
    event: "ready",
    data: JSON.stringify({ cursor: from, refused: [] }),
  });
  expect(await frames.next()).toEqual({ retry: "3000" });
  expect(await frames.next()).toEqual({
    id: missed,
    data: JSON.stringify({ channel: "chat:42", event: "message", payload: { text: "missed" } }),
  });
  expect(await frames.next()).toEqual({ event: "caught-up", data: "{}" });

  const live = await chat.message({ text: "live" });
  expect((await frames.next()).id).toBe(live);
  await frames.cancel();
});

test("Last-Event-ID wins over the Cursor in the query", async () => {
  const transport = createMemoryTransport();
  const sse = appWith(transport);
  const chat = sse.chat({ roomId: "42" });
  const stale = await transport.tail();
  await chat.message({ text: "the query would replay this" });
  const header = await chat.message({ text: "and this" });
  const wanted = await chat.message({ text: "only this one is missing" });

  const frames = framesOf(
    await connect(sse, `?channel=chat:42&cursor=${stale}`, {
      headers: { "Last-Event-ID": header },
    }),
  );

  expect(JSON.parse((await frames.next()).data ?? "")).toEqual({ cursor: header, refused: [] });
  await frames.next();

  expect((await frames.next()).id).toBe(wanted);
  expect(await frames.next()).toEqual({ event: "caught-up", data: "{}" });
  await frames.cancel();
});

test("an empty Cursor is no Cursor at all: the Connection adopts the tail, live-only", async () => {
  const transport = createMemoryTransport();
  const sse = appWith(transport);
  await sse.chat({ roomId: "42" }).message({ text: "long before" });
  const tail = await transport.tail();

  const frames = framesOf(
    await connect(sse, "?channel=chat:42&cursor=", { headers: { "Last-Event-ID": "" } }),
  );

  expect(JSON.parse((await frames.next()).data ?? "")).toEqual({ cursor: tail, refused: [] });
  await frames.next();

  expect(await frames.next()).toEqual({ event: "caught-up", data: "{}" });
  await frames.cancel();
});

/**
 * ADR-0006 supersedes ADR-0004 here: a Cursor the log cannot serve is never a `400`, because
 * the client core retries a non-200 with the same URL forever. It is a `200` stream carrying
 * the tail as its Cursor and a `reset` in band, so the App refetches once and goes on live.
 */
test.each([
  ["one the log has dropped", true],
  ["one no log ever minted", false],
])("a Cursor %s is a 200 stream with a reset, never a non-200", async (_case, dropped) => {
  const transport = createMemoryTransport({ retention: { cap: 1 } });
  const sse = appWith(transport);
  const chat = sse.chat({ roomId: "42" });
  const stale = await chat.message({ text: "one" });
  await chat.message({ text: "two" });
  await chat.message({ text: "three" });
  const cursor = dropped ? stale : "not-a-cursor";

  const response = await connect(sse, `?channel=chat:42&cursor=${cursor}`);
  const frames = framesOf(response);

  expect(response.status).toBe(200);
  expect(await frames.next()).toEqual({
    event: "ready",
    data: JSON.stringify({ cursor: await transport.tail(), refused: [] }),
  });
  expect(await frames.next()).toEqual({ retry: "3000" });
  expect(await frames.next()).toEqual({ event: "reset", data: "{}" });
  expect(await frames.next()).toEqual({ event: "caught-up", data: "{}" });

  const live = await chat.message({ text: "after the reset" });
  expect((await frames.next()).id).toBe(live);
  await frames.cancel();
});
