import { getEventListeners } from "node:events";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { TransportUnavailableError } from "../transport/index.js";
import type { Transport } from "../transport/index.js";
import { createMemoryTransport } from "../transport/memory.js";

import { chatApp, type ChatApp } from "./chat-app.testkit.js";
import { framesOf, type Frames } from "./frames.testkit.js";
import { asType, initSSE } from "./index.js";
import { getInstance } from "./instance.js";

beforeEach(() => {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  delete globals[Symbol.for("@flefebvre/next-sse")];
});

/**
 * The cases about timing run on fake timers, with the interval shortened through the App's own
 * configuration rather than through a branch this library only takes in a test.
 */
afterEach(() => {
  vi.useRealTimers();
});

/** The App of these tests, as every suite about Connections builds it. */
const appWith = (
  transport = createMemoryTransport(),
  lifecycle: { heartbeat?: number; maxLifetime?: number } = {},
): ChatApp => chatApp({ transport, ...lifecycle });

/**
 * An App whose Channel is guarded by the decision the test hands it, with a context built from
 * the request the way a real one builds it from a session cookie.
 */
const guardedApp = (
  authorize: (params: { roomId: string }, ctx: Role) => boolean | Promise<boolean>,
  options: {
    transport?: Transport;
    context?: (request: Request) => Role | Promise<Role>;
    key?: (ctx: Role) => string | undefined;
  } = {},
): ChatApp => {
  const { channel, createSSE } = initSSE({
    drain: false,
    transport: options.transport ?? createMemoryTransport(),
    context: options.context ?? ((request) => ({ role: request.headers.get("x-role") ?? "guest" })),
    key: options.key,
  });

  return createSSE({
    chat: channel({
      pattern: "chat:{roomId}",
      events: { message: asType<{ text: string }>() },
      authorize,
    }),
  }) as unknown as ChatApp;
};

/** What the guarded App builds per request: the least a decision can be taken on. */
interface Role {
  role: string;
}

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

/**
 * The end of a Connection, as its client reads it: the `reconnect` Control event, the end of the
 * stream, and nothing of it left in the Instance's table. Every ending goes through one primitive,
 * so every test of one asserts the same three things.
 */
const endsWithReconnect = async (frames: Frames): Promise<void> => {
  expect(await frames.next()).toEqual({ event: "reconnect", data: "{}" });
  await expect(frames.next()).rejects.toThrow("the stream ended");
  expect(getInstance().connections.size).toBe(0);
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
    data: JSON.stringify({ cursor: tail, refused: [], heartbeat: 15_000 }),
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
    data: JSON.stringify({ cursor: from, refused: [], heartbeat: 15_000 }),
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

  expect(JSON.parse((await frames.next()).data ?? "")).toEqual({
    cursor: header,
    refused: [],
    heartbeat: 15_000,
  });
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

  expect(JSON.parse((await frames.next()).data ?? "")).toEqual({
    cursor: tail,
    refused: [],
    heartbeat: 15_000,
  });
  await frames.next();

  expect(await frames.next()).toEqual({ event: "caught-up", data: "{}" });
  await frames.cancel();
});

/**
 * An App whose log has dropped what a Connection is about to bring: three Messages under a
 * retention of one, and the Cursor of the first of them, which the log no longer serves.
 */
const withADroppedCursor = async (): Promise<{
  transport: Transport;
  sse: ChatApp;
  chat: ReturnType<ChatApp["chat"]>;
  stale: string;
}> => {
  const transport = createMemoryTransport({ retention: { cap: 1 } });
  const sse = appWith(transport);
  const chat = sse.chat({ roomId: "42" });
  const stale = await chat.message({ text: "one" });
  await chat.message({ text: "two" });
  await chat.message({ text: "three" });

  return { transport, sse, chat, stale };
};

/**
 * ADR-0006 supersedes ADR-0004 here: a Cursor the log cannot serve is never a `400`, because
 * the client core retries a non-200 with the same URL forever. It is a `200` stream carrying
 * the tail as its Cursor and a `reset` in band, so the App refetches once and goes on live.
 */
test.each([
  ["one the log has dropped", true],
  ["one no log ever minted", false],
])("a Cursor %s is a 200 stream with a reset, never a non-200", async (_case, dropped) => {
  const { transport, sse, chat, stale } = await withADroppedCursor();
  const cursor = dropped ? stale : "not-a-cursor";

  const response = await connect(sse, `?channel=chat:42&cursor=${cursor}`);
  const frames = framesOf(response);

  expect(response.status).toBe(200);
  expect(await frames.next()).toEqual({
    event: "ready",
    data: JSON.stringify({ cursor: await transport.tail(), refused: [], heartbeat: 15_000 }),
  });
  expect(await frames.next()).toEqual({ retry: "3000" });
  expect(await frames.next()).toEqual({
    event: "reset",
    data: JSON.stringify({ cursor: await transport.tail() }),
  });
  expect(await frames.next()).toEqual({ event: "caught-up", data: "{}" });

  const live = await chat.message({ text: "after the reset" });
  expect((await frames.next()).id).toBe(live);
  await frames.cancel();
});

/**
 * The whole point of `reset` naming a position, on the real stream: a page with no Snapshot to
 * supersede its Cursor — every live-only hook — otherwise keeps holding the very Cursor that was
 * just refused, and meets the same refusal on its next reconnect. One `reset`, one refetch, and
 * from then on this client is where the Instance put it.
 */
test("a reconnect from the position a reset carried is not reset a second time", async () => {
  const { sse, stale } = await withADroppedCursor();

  const first = framesOf(await connect(sse, `?channel=chat:42&cursor=${stale}`));
  await first.next();
  await first.next();
  const reset = await first.next();
  expect(reset.event).toBe("reset");
  const carried = (JSON.parse(reset.data ?? "") as { cursor: string }).cursor;
  await first.cancel();

  const again = framesOf(
    await connect(sse, "?channel=chat:42", { headers: { "Last-Event-ID": carried } }),
  );
  await again.next();
  await again.next();

  expect(await again.next()).toEqual({ event: "caught-up", data: "{}" });
  await again.cancel();
});

/**
 * The shape of every partial refusal: the Channels that passed stream as they always would, and
 * the ones that did not are named in `ready` — on a `200`, because a browser `EventSource` shows
 * the client neither the status nor the body of anything else (ADR-0003).
 */
test("a refused Channel is dropped from the Connection, and the others stream", async () => {
  const transport = createMemoryTransport();
  const sse = guardedApp(({ roomId }) => roomId !== "secret", { transport });

  const frames = framesOf(await connect(sse, "?channel=chat:42&channel=chat:secret"));

  expect(JSON.parse((await frames.next()).data ?? "")).toEqual({
    cursor: await transport.tail(),
    refused: ["chat:secret"],
    heartbeat: 15_000,
  });
  await frames.next();
  expect(await frames.next()).toEqual({ event: "caught-up", data: "{}" });
  expect([...getInstance().connections][0]?.channels).toEqual(new Set(["chat:42"]));

  await sse.chat({ roomId: "secret" }).message({ text: "not for you" });
  const mine = await sse.chat({ roomId: "42" }).message({ text: "for me" });

  expect((await frames.next()).id).toBe(mine);
  await frames.cancel();
});

/**
 * Every Channel refused: still a `200` naming them all, and then the end of the stream. No
 * Cursor, because no Connection was opened and there is nothing to resume; no `retry:`, because
 * the core closes this Connection itself rather than reopening one that would say the same.
 */
test("a Connection refused every Channel is told so, and the stream ends", async () => {
  const sse = guardedApp(() => false);

  const response = await connect(sse, "?channel=chat:42&channel=chat:7");
  const frames = framesOf(response);

  expect(response.status).toBe(200);
  expect(await frames.next()).toEqual({
    event: "ready",
    data: JSON.stringify({ refused: ["chat:42", "chat:7"] }),
  });
  await expect(frames.next()).rejects.toThrow(/ended/);
  expect(getInstance().connections.size).toBe(0);
});

/**
 * A Channel this App does not declare is refused exactly the way a denied one is: the client
 * must not be able to tell "you may not have this" from "there is no such thing". The App does
 * hear the difference, once, on its own server.
 */
test("an unknown Channel is refused like a denied one, and warned about server-side", async () => {
  const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  /** Both Apps share the process-wide Instance, so the denied one connects before the other. */
  const declaring = initSSE({ drain: false, transport: createMemoryTransport() });
  const denies = declaring.createSSE({
    presence: declaring.channel({
      pattern: "presence:{roomId}",
      events: {},
      authorize: () => false,
    }),
  }) as unknown as ChatApp;

  const denied = framesOf(await connect(denies, "?channel=presence:42"));
  const unknown = framesOf(
    await connect(
      guardedApp(() => true),
      "?channel=presence:42",
    ),
  );

  expect(await unknown.next()).toEqual(await denied.next());
  expect(warned).toHaveBeenCalledTimes(1);
  expect(warned.mock.calls[0]?.[0]).toMatch(/presence:42.*Registry mismatch/s);
});

/** Authorize is asked about the Channel as its own pattern describes it, not as a string. */
test("Authorize is given the params of the Channel and the context of the request", async () => {
  const seen: { params: unknown; ctx: unknown }[] = [];
  const built = vi.fn((request: Request) => ({ role: request.headers.get("x-role") ?? "guest" }));
  const sse = guardedApp(
    (params, ctx) => {
      seen.push({ params, ctx });

      return ctx.role === "admin";
    },
    { context: built },
  );

  const frames = framesOf(
    await connect(sse, "?channel=chat:42&channel=chat:7", { headers: { "x-role": "admin" } }),
  );

  expect(seen).toEqual([
    { params: { roomId: "42" }, ctx: { role: "admin" } },
    { params: { roomId: "7" }, ctx: { role: "admin" } },
  ]);
  expect(built).toHaveBeenCalledTimes(1);
  await frames.cancel();
});

/** The decision is taken again on every connect, which is what makes a reconnect re-decide. */
test("Authorize runs again on the next Connection, and decides afresh", async () => {
  const sse = guardedApp((_params, ctx) => ctx.role === "admin");

  const refused = framesOf(await connect(sse, "?channel=chat:42"));
  expect(JSON.parse((await refused.next()).data ?? "").refused).toEqual(["chat:42"]);

  const allowed = framesOf(
    await connect(sse, "?channel=chat:42", { headers: { "x-role": "admin" } }),
  );
  expect(JSON.parse((await allowed.next()).data ?? "").refused).toEqual([]);
  await allowed.cancel();
});

/**
 * A decision that could not be taken is not a decision. Answering `refused` for a database that
 * blinked would leave the page reporting a terminal refusal for something transient; a non-200
 * is what the client core already retries with backoff (ADR-0004).
 */
test.each([
  ["authorize", () => guardedApp(() => Promise.reject(new Error("the database is down")))],
  [
    "context",
    () =>
      guardedApp(() => true, {
        context: () => {
          throw new Error("the session store is down");
        },
      }),
  ],
])("a throwing %s is a 500 before the stream opens, not a refusal", async (_case, build) => {
  const failed = vi.spyOn(console, "error").mockImplementation(() => undefined);

  const response = await connect(build(), "?channel=chat:42");

  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).not.toContain("text/event-stream");
  expect(getInstance().connections.size).toBe(0);
  expect(failed).toHaveBeenCalledTimes(1);
});

/**
 * The Key is what a Kick addresses Connections by (ADR-0003), so the Connection table carries it
 * from the first Connection onwards.
 */
test("the Key this App derives lands on the Connection", async () => {
  const sse = guardedApp(() => true, { key: (ctx) => `user:${ctx.role}` });
  const frames = framesOf(await connect(sse, "?channel=chat:42", { headers: { "x-role": "ada" } }));
  await frames.next();

  expect([...getInstance().connections][0]?.key).toBe("user:ada");
  await frames.cancel();
});

/**
 * An empty Key is no Key: it is what a `key` reading a missing session header returns without
 * meaning to, and a Connection holding one could never be Kicked — `sse.kick({ key: "" })` names
 * nothing and is refused. The two ends have to agree, so it lands as no Key at all.
 */
test("a Key that comes out empty lands on the Connection as no Key", async () => {
  const sse = guardedApp(() => true, { key: () => "" });
  const frames = framesOf(await connect(sse, "?channel=chat:42", { headers: { "x-role": "ada" } }));
  await frames.next();

  expect([...getInstance().connections][0]?.key).toBeUndefined();
  await frames.cancel();
});

/** An App that configures no `key` names nobody, and the Connection carries no Key at all. */
test("an App that derives no Key opens Connections without one", async () => {
  const frames = framesOf(
    await connect(
      guardedApp(() => true),
      "?channel=chat:42",
    ),
  );
  await frames.next();

  expect([...getInstance().connections][0]?.key).toBeUndefined();
  await frames.cancel();
});

/**
 * The heartbeat is what keeps a proxy from idling a quiet Connection out, and what the client
 * core watches to tell a live pipe from one that died without saying so. It is a named Control
 * event rather than an SSE comment precisely so that JavaScript can see it, and it carries no
 * `id:`, so it can fall anywhere in the stream without moving anybody's Cursor (ADR-0004).
 */
test("a Connection is heartbeated on the interval this App configured", async () => {
  vi.useFakeTimers();
  const sse = appWith(createMemoryTransport(), { heartbeat: 100 });
  const frames = await liveConnection(sse, "?channel=chat:42");

  await vi.advanceTimersByTimeAsync(100);
  expect(await frames.next()).toEqual({ event: "heartbeat", data: "{}" });

  await vi.advanceTimersByTimeAsync(100);
  expect(await frames.next()).toEqual({ event: "heartbeat", data: "{}" });

  await frames.cancel();
});

/**
 * The interval travels in `ready` so that the two sides cannot be configured apart: the client
 * watchdog is 3× whatever this Connection was actually given, not 3× what the browser bundle
 * was built believing.
 */
test("the interval this App configured is what ready carries", async () => {
  const sse = appWith(createMemoryTransport(), { heartbeat: 100 });

  const frames = framesOf(await connect(sse, "?channel=chat:42"));

  expect(JSON.parse((await frames.next()).data ?? "")).toEqual({
    cursor: expect.any(String),
    refused: [],
    heartbeat: 100,
  });
  await frames.cancel();
});

/** `0` is off, and never "use the default": a Connection nothing will write to unprompted. */
test("a heartbeat of 0 is a Connection that is never heartbeated", async () => {
  vi.useFakeTimers();
  const sse = appWith(createMemoryTransport(), { heartbeat: 0, maxLifetime: 0 });
  const frames = framesOf(await connect(sse, "?channel=chat:42"));

  expect(JSON.parse((await frames.next()).data ?? "").heartbeat).toBe(0);
  await frames.next();
  expect(await frames.next()).toEqual({ event: "caught-up", data: "{}" });

  await vi.advanceTimersByTimeAsync(60 * 60_000);
  const live = await sse.chat({ roomId: "42" }).message({ text: "an hour later" });

  expect((await frames.next()).id).toBe(live);
  await frames.cancel();
});

/**
 * A timer still firing at a stream nobody reads outlives the client by the length of the
 * process, which is why it is cleared on the one teardown every ending goes through.
 */
test("a client that goes away leaves no heartbeat behind", async () => {
  vi.useFakeTimers();
  const sse = appWith(createMemoryTransport(), { heartbeat: 100 });
  const frames = await liveConnection(sse, "?channel=chat:42");

  await frames.cancel();

  expect(vi.getTimerCount()).toBe(0);
});

/**
 * The max lifetime, and with it the one way a Connection is ended from the server side: the
 * `reconnect` Control event and the end of the stream. The client core comes back at once with
 * its Cursor, which is what makes the cut gap-free — and what Kick and Drain will reuse whole.
 */
test("a Connection that reaches its max lifetime is ended with reconnect", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const sse = appWith(createMemoryTransport(), { maxLifetime: 1000 });
  const frames = await liveConnection(sse, "?channel=chat:42");

  await vi.advanceTimersByTimeAsync(1000);

  await endsWithReconnect(frames);
});

/**
 * ±10 % full jitter, drawn per Connection: an Instance whose Connections all started together
 * does not end them together, which is the herd the lifetime exists to prevent.
 */
test.each([
  ["the low end of the spread", 0, 900],
  ["the high end of the spread", 1, 1100],
])("a Connection ends at %s", async (_case, random, expected) => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(random);
  const sse = appWith(createMemoryTransport(), { maxLifetime: 1000 });
  await liveConnection(sse, "?channel=chat:42");

  await vi.advanceTimersByTimeAsync(expected - 1);
  expect(getInstance().connections.size).toBe(1);

  await vi.advanceTimersByTimeAsync(1);
  expect(getInstance().connections.size).toBe(0);
});

test("a maxLifetime of 0 is a Connection nothing brings to an end", async () => {
  vi.useFakeTimers();
  const sse = appWith(createMemoryTransport(), { maxLifetime: 0, heartbeat: 0 });
  const frames = await liveConnection(sse, "?channel=chat:42");

  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

  expect(getInstance().connections.size).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
  const live = await sse.chat({ roomId: "42" }).message({ text: "a day later" });
  expect((await frames.next()).id).toBe(live);
  await frames.cancel();
});

/**
 * A Transport that is away: every operation rejects promptly and nothing is queued, which is
 * what the Redis Transport does behind a backend it cannot reach (ADR-0006).
 */
const unreachable = (): Transport => {
  const away = (): never => {
    throw new TransportUnavailableError("the backend is away");
  };

  return {
    publish: away,
    read: away,
    tail: away,
    subscribe: away,
    close: async () => undefined,
  } as unknown as Transport;
};

/**
 * The one non-200 a working App can answer after Authorize: the Instance cannot reach its log,
 * so it cannot serve this Connection at all. It is a status rather than a stream that breaks
 * after its headers, which is what lets a load balancer read it — and the client core retries
 * it forever, because a `503` is a Transport that will come back (ADR-0004).
 */
test("a connect while the Transport is away is a 503 saying when to come back", async () => {
  const sse = appWith(unreachable());

  const response = await connect(sse, "?channel=chat:42");

  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("5");
  expect(getInstance().connections.size).toBe(0);
});

/**
 * The other "not now" this handler answers, and the one a rolling deploy turns on: this Instance
 * is draining, so it sends the client to a surviving one rather than opening a Connection it is
 * about to end (ADR-0011). It is the same status and the same header as the Transport being
 * away, because whatever is in front of this App reads the two the same way.
 *
 * It is answered before the App is asked anything at all: no context is built and no Authorize
 * runs, because there is no decision to take about a Connection that is not being opened.
 */
test("a connect while this Instance is draining is a 503, taken before Authorize", async () => {
  const context = vi.fn(() => ({ role: "admin" }));
  const authorize = vi.fn(() => true);
  const sse = guardedApp(authorize, { context });
  await sse.drain();

  const response = await connect(sse, "?channel=chat:42");

  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("5");
  expect(context).not.toHaveBeenCalled();
  expect(authorize).not.toHaveBeenCalled();
});

/**
 * The bound on a Connection nobody is reading. A slow client accumulates on the Instance for as
 * long as its Connection lasts, and neither the heartbeat nor the max lifetime bounds that: what
 * does is ending the Connection the one way a Connection is ended. Nothing is dropped — the
 * client comes back with its Cursor and is replayed what it had not read — so the cost of being
 * slow is a round trip per megabyte rather than an Instance's memory.
 */
test("a Connection whose client is not reading is ended with reconnect, not left to grow", async () => {
  const sse = appWith(createMemoryTransport(), { heartbeat: 0, maxLifetime: 0 });
  const response = await connect(sse, "?channel=chat:42");
  const text = "x".repeat(100_000);

  for (let n = 0; n < 12; n += 1) {
    await sse.chat({ roomId: "42" }).message({ text });
  }

  expect(getInstance().connections.size).toBe(0);

  const frames = framesOf(response);
  const seen: string[] = [];
  for (;;) {
    const frame = await frames.next();
    if (frame.event === "reconnect") break;
    seen.push(frame.event ?? (frame.id === undefined ? "retry" : "message"));
  }

  expect(seen.slice(0, 3)).toEqual(["ready", "retry", "caught-up"]);
  const delivered = seen.filter((event) => event === "message").length;
  expect(delivered).toBeGreaterThan(0);
  expect(delivered).toBeLessThan(12);
  await expect(frames.next()).rejects.toThrow("the stream ended");
});

/**
 * A Transport whose tail this test holds, so that a Connection can be caught in the window it is
 * registered in but not yet opened — which is the window a Kick or a Drain walking the Connection
 * table reaches it in.
 */
const holdingTheTail = (): { transport: Transport; release: () => void } => {
  const memory = createMemoryTransport();
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    transport: {
      ...memory,
      tail: async () => {
        await held;

        return memory.tail();
      },
    },
    release: () => {
      release();
    },
  };
};

/**
 * The primitive Kick and Drain will rest on, exercised the way they will use it: over the
 * Instance's Connection table, on a Connection that is still opening. It is told where it stands
 * and to come back, and it runs no replay — what it missed is the next Connection's to carry, and
 * it has the Cursor to ask for it with.
 */
test("a Connection ended while it is still opening carries ready, the retry and reconnect", async () => {
  const { transport, release } = holdingTheTail();
  const sse = appWith(transport, { heartbeat: 0, maxLifetime: 0 });
  const responding = connect(sse, "?channel=chat:42");
  await vi.waitFor(() => expect(getInstance().connections.size).toBe(1));

  const [held] = [...getInstance().connections];
  held?.reconnect();
  release();

  const frames = framesOf(await responding);
  expect((await frames.next()).event).toBe("ready");
  expect(await frames.next()).toEqual({ retry: "3000" });
  await endsWithReconnect(frames);
});

test("ending a Connection twice ends it once", async () => {
  const sse = appWith(createMemoryTransport(), { heartbeat: 0, maxLifetime: 0 });
  const frames = await liveConnection(sse, "?channel=chat:42");
  const [held] = [...getInstance().connections];

  held?.reconnect();
  held?.reconnect();

  await endsWithReconnect(frames);
});

test("ending a Connection whose client has already gone does nothing at all", async () => {
  const sse = appWith(createMemoryTransport(), { heartbeat: 0, maxLifetime: 0 });
  const client = new AbortController();
  await connect(sse, "?channel=chat:42", { signal: client.signal });
  const [held] = [...getInstance().connections];

  client.abort();

  expect(() => held?.reconnect()).not.toThrow();
  expect(getInstance().connections.size).toBe(0);
});
