import { beforeEach, expect, test, vi } from "vitest";

import type { ChannelRecord } from "../internal/channel.js";
import { createMemoryTransport } from "../transport/memory.js";
import type { Entry, Transport } from "../transport/index.js";

import { getInstance, type Connection, type Instance } from "./instance.js";
import type { StoredMessage } from "./wire.js";

/**
 * The Instance is a process-wide slot on purpose, so each test starts by emptying the slot the
 * way a fresh process would find it. Reaching for the symbol here is not a shortcut around the
 * module: the slot is the seam ADR-0004 specifies, and this is what asserts it is really used.
 */
beforeEach(() => {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  delete globals[Symbol.for("@flefebvre/next-sse")];
});

const message = (channel: string, payload: unknown): Entry => ({
  v: 1,
  type: "message",
  channel,
  event: "message",
  payload,
});

/** One Connection, with everything the Instance tells it recorded as it is told. */
const connectionOn = (...channels: string[]): Connection => ({
  channels: new Set(channels),
  deliver: vi.fn<(entry: StoredMessage) => void>(),
  reset: vi.fn<() => void>(),
  caughtUp: vi.fn<() => void>(),
});

/**
 * A Connection that records everything the Instance tells it, in one list and in order: a
 * Message as `<channel> <text>`, and the two Control moments by name. Order is what most of
 * the replay cases are about — where `caught-up` falls, and what a Message is next to.
 */
const tracing = (...channels: string[]): { connection: Connection; trace: string[] } => {
  const trace: string[] = [];

  return {
    connection: {
      channels: new Set(channels),
      deliver: (entry) => trace.push(`${entry.channel} ${(entry.payload as Text).text}`),
      reset: () => trace.push("reset"),
      caughtUp: () => trace.push("caught-up"),
    },
    trace,
  };
};

interface Text {
  text: string;
}

/**
 * The state both handoff-window cases start from: a log holding one Message this Connection
 * missed, and the Cursor it is about to resume from.
 */
const aboutToResume = async (): Promise<{
  transport: Transport;
  instance: Instance;
  from: string;
  connection: Connection;
  trace: string[];
}> => {
  const transport = createMemoryTransport();
  const instance = getInstance({ transport });
  const from = await transport.tail();
  await transport.publish(message("chat:42", { text: "missed" }));

  return { transport, instance, from, ...tracing("chat:42") };
};

/**
 * Make the next `read` Publish, before or after it takes the page it answers. This is how a
 * test lands a Publish inside the replay window on purpose: what goes `before` is in the page
 * **and** in the Instance's buffer, what goes `after` is only in the buffer.
 */
const publishingDuringRead = (
  transport: Transport,
  { before = [], after = [] }: { before?: Entry[]; after?: Entry[] },
): void => {
  const read = transport.read.bind(transport);
  vi.spyOn(transport, "read").mockImplementationOnce(async (from, limit) => {
    for (const entry of before) await transport.publish(entry);
    const page = await read(from, limit);
    for (const entry of after) await transport.publish(entry);

    return page;
  });
};

/**
 * A Connection past its opening: registered, replayed, live. This is where every test about
 * the live feed starts, and it is the two-phase open in one line.
 */
const live = async (
  instance: Instance,
  connection: Connection,
  after?: string,
): Promise<() => void> => {
  const opening = await instance.open(connection, { after });
  await opening.start();

  return opening.close;
};

test("the Instance keeps its Transport across evaluations, whatever a later one brings", () => {
  const first = createMemoryTransport();
  const second = createMemoryTransport();

  const instance = getInstance({ transport: first });

  expect(getInstance({ transport: second }).transport).toBe(first);
  expect(getInstance()).toBe(instance);
});

test("the Instance keeps its Connections across evaluations, and swaps the Registry", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  instance.registry = registryOf("chat:{roomId}");
  const connection = connectionOn("chat:42");
  await live(instance, connection);

  const reevaluated = getInstance({ transport: createMemoryTransport() });
  reevaluated.registry = registryOf("presence:{roomId}");

  expect(reevaluated.connections.has(connection)).toBe(true);
  expect(instance.registry?.chat?.pattern).toBe("presence:{roomId}");
});

/**
 * `context` and `key` are App code holding no live state, so a re-evaluated module swaps them
 * the way it swaps the Registry — unlike the Transport, which the open Connections are on.
 * Without this an edit to `context` in development would do nothing until the process restarts,
 * while the Authorize beside it, which lives in the Registry, would already have changed.
 */
test("the Instance swaps the context and the Key builder across evaluations", () => {
  const context = () => ({ role: "admin" });
  const key = () => "ada";
  const instance = getInstance({ transport: createMemoryTransport(), context, key });

  expect(instance.context).toBe(context);
  expect(instance.key).toBe(key);

  const second = () => ({ role: "guest" });
  getInstance({ transport: createMemoryTransport(), context: second });

  expect(instance.context).toBe(second);
  expect(instance.key).toBeUndefined();
});

/** One Registry, as data: the handler reads patterns and Authorize off exactly this shape. */
const registryOf = (pattern: string): ChannelRecord => ({
  chat: { pattern, events: {}, authorize: () => true },
});

test("a Message reaches the Connections subscribed to its Channel, and no others", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const subscribed = connectionOn("chat:42", "chat:7");
  const elsewhere = connectionOn("chat:7");
  await live(instance, subscribed);
  await live(instance, elsewhere);

  const cursor = await instance.transport.publish(message("chat:42", { text: "hello" }));

  expect(subscribed.deliver).toHaveBeenCalledWith({
    ...message("chat:42", { text: "hello" }),
    cursor,
  });
  expect(elsewhere.deliver).not.toHaveBeenCalled();
});

test("a Publish this Instance made itself comes back through the log like any other", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const connection = connectionOn("chat:42");
  await live(instance, connection);

  await instance.transport.publish(message("chat:42", { text: "one" }));
  await instance.transport.publish(message("chat:42", { text: "two" }));

  expect(connection.deliver).toHaveBeenCalledTimes(2);
});

test("an Entry for a Channel nobody here holds, and a control Entry, reach no Connection", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const connection = connectionOn("chat:42");
  await live(instance, connection);

  await instance.transport.publish(message("chat:other", { text: "hello" }));
  await instance.transport.publish({ v: 1, type: "control", control: "kick", channel: "chat:42" });

  expect(connection.deliver).not.toHaveBeenCalled();
});

test("a Connection that was closed leaves the table and is fed nothing further", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const connection = connectionOn("chat:42");
  const close = await live(instance, connection);

  close();
  await instance.transport.publish(message("chat:42", { text: "hello" }));

  expect(instance.connections.size).toBe(0);
  expect(connection.deliver).not.toHaveBeenCalled();
});

test("the Instance reads the log once, however many Connections it holds", async () => {
  const transport = createMemoryTransport();
  const subscribe = vi.spyOn(transport, "subscribe");
  const instance = getInstance({ transport });

  await live(instance, connectionOn("chat:42"));
  await live(instance, connectionOn("chat:7"));

  expect(subscribe).toHaveBeenCalledTimes(1);
});

test("a Connection resuming from a Cursor is replayed what came after it, and nothing else", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  await instance.transport.publish(message("chat:42", { text: "before" }));
  const from = await instance.transport.publish(message("chat:42", { text: "the last it saw" }));
  await instance.transport.publish(message("chat:42", { text: "missed" }));
  const { connection, trace } = tracing("chat:42");

  const opening = await instance.open(connection, { after: from });
  await opening.start();

  expect(opening.cursor).toBe(from);
  expect(trace).toEqual(["chat:42 missed", "caught-up"]);
});

test("replay carries no control Entry and no Channel the Connection did not name", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const from = await instance.transport.tail();
  await instance.transport.publish({ v: 1, type: "control", control: "kick", key: "user-7" });
  await instance.transport.publish(message("chat:other", { text: "elsewhere" }));
  await instance.transport.publish(message("chat:42", { text: "here" }));
  const { connection, trace } = tracing("chat:42");

  await (await instance.open(connection, { after: from })).start();

  expect(trace).toEqual(["chat:42 here", "caught-up"]);
});

test("a replay long enough to span several pages carries every Entry, once, in order", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const from = await instance.transport.tail();
  for (let n = 0; n < 1201; n += 1) {
    await instance.transport.publish(message("chat:42", { text: `n${String(n)}` }));
  }
  const { connection, trace } = tracing("chat:42");

  await (await instance.open(connection, { after: from })).start();

  expect(trace).toHaveLength(1202);
  expect(trace[0]).toBe("chat:42 n0");
  expect(trace[1200]).toBe("chat:42 n1200");
  expect(trace[1201]).toBe("caught-up");
});

/**
 * The handoff itself: a Publish that lands while the replay is running is in the page the log
 * answers **and** in the buffer the Instance started filling before it read. The cut is what
 * makes it one delivery, and it is an equality search — the Instance never orders two Cursors.
 */
test("a Message published while the replay is running is delivered exactly once", async () => {
  const { transport, instance, from, connection, trace } = await aboutToResume();

  publishingDuringRead(transport, { before: [message("chat:42", { text: "mid-replay" })] });

  await (await instance.open(connection, { after: from })).start();

  expect(trace).toEqual(["chat:42 missed", "chat:42 mid-replay", "caught-up"]);
});

/**
 * The other side of the same window: a Publish the log answered before it happened is only in
 * the buffer, so the cut must leave it alone — and it arrives after `caught-up`, because it is
 * live, not replay.
 */
test("a Message published after the last replay page is delivered once, after caught-up", async () => {
  const { transport, instance, from, connection, trace } = await aboutToResume();

  publishingDuringRead(transport, { after: [message("chat:42", { text: "after the page" })] });

  await (await instance.open(connection, { after: from })).start();

  expect(trace).toEqual(["chat:42 missed", "caught-up", "chat:42 after the page"]);
});

/**
 * The buffer is filled with every Entry, whatever its Channel and kind, precisely so that the
 * Cursor the replay ends on can be found in it: here the last Entry replayed belongs to a
 * Channel this Connection never named, and the cut still lands in the right place.
 */
test("the cut holds when the replay ends on an Entry this Connection is not subscribed to", async () => {
  const transport = createMemoryTransport();
  const instance = getInstance({ transport });
  const from = await transport.tail();
  const { connection, trace } = tracing("chat:42");

  publishingDuringRead(transport, {
    before: [message("chat:42", { text: "mid-replay" }), message("chat:other", { text: "x" })],
  });

  await (await instance.open(connection, { after: from })).start();
  await transport.publish(message("chat:42", { text: "live" }));

  expect(trace).toEqual(["chat:42 mid-replay", "caught-up", "chat:42 live"]);
});

test("a Cursor the log has dropped opens on the tail, with a reset and no replay", async () => {
  const transport = createMemoryTransport({ retention: { cap: 1 } });
  const instance = getInstance({ transport });
  const stale = await transport.publish(message("chat:42", { text: "one" }));
  await transport.publish(message("chat:42", { text: "two" }));
  await transport.publish(message("chat:42", { text: "three" }));
  const { connection, trace } = tracing("chat:42");

  const opening = await instance.open(connection, { after: stale });
  expect(opening.cursor).toBe(await transport.tail());
  expect(opening.cursor).not.toBe(stale);

  await opening.start();
  await transport.publish(message("chat:42", { text: "live" }));

  expect(trace).toEqual(["reset", "caught-up", "chat:42 live"]);
});

/**
 * ADR-0004's live-only connect: the tail is a read that writes nothing, and it is what makes
 * the *next* Connection gap-free — a client that never received a Message still reconnects
 * from a position rather than from nothing.
 */
test("a live-only connect adopts the tail, and a reconnect from it misses nothing", async () => {
  const transport = createMemoryTransport();
  const instance = getInstance({ transport });
  await transport.publish(message("chat:42", { text: "long before" }));
  const first = tracing("chat:42");

  const opening = await instance.open(first.connection);
  await opening.start();
  opening.close();

  await transport.publish(message("chat:42", { text: "while it was away" }));
  const second = tracing("chat:42");
  await (await instance.open(second.connection, { after: opening.cursor })).start();

  expect(first.trace).toEqual(["caught-up"]);
  expect(second.trace).toEqual(["chat:42 while it was away", "caught-up"]);
});

/**
 * A live-only connect is registered before it reads the tail, so a Publish landing in that
 * window is in its buffer while the Cursor it adopted already covers it. It is delivered: this
 * client has seen nothing yet, so that is over-delivery and not a duplicate, and its position
 * follows what it actually receives. Withholding it would mean ordering two Cursors, which the
 * Instance cannot do — and could not do reliably anyway against a feed that lags `read`.
 */
test("a live-only connect is fed what landed in its opening window, and still adopts the tail", async () => {
  const transport = createMemoryTransport();
  const instance = getInstance({ transport });
  const { connection, trace } = tracing("chat:42");

  const tail = transport.tail.bind(transport);
  vi.spyOn(transport, "tail").mockImplementationOnce(async () => {
    await transport.publish(message("chat:42", { text: "in the opening window" }));

    return tail();
  });

  const opening = await instance.open(connection);
  expect(opening.cursor).toBe(await tail());

  await opening.start();
  await transport.publish(message("chat:42", { text: "live" }));

  expect(trace).toEqual(["caught-up", "chat:42 in the opening window", "chat:42 live"]);
});

test("a Connection that never opened its replay is fed nothing, and leaves no trace behind", async () => {
  const transport = createMemoryTransport();
  const instance = getInstance({ transport });
  const { connection, trace } = tracing("chat:42");

  const opening = await instance.open(connection);
  await transport.publish(message("chat:42", { text: "while it was opening" }));
  opening.close();
  await transport.publish(message("chat:42", { text: "after it left" }));

  expect(trace).toEqual([]);
  expect(instance.connections.size).toBe(0);
});

/**
 * The seam as a Transport whose reader runs behind its `read` presents it: the Entry the replay
 * ended on reaches the live feed only after the Connection has been handed to it. The contract
 * promises delivery after `subscribe`, never that the feed keeps up with a concurrent `read`
 * (ADR-0005), so this is the ordinary case for Redis — and the Connection must still see that
 * Entry exactly once.
 */
test("an Entry the feed delivers late, after the replay carried it, is not delivered twice", async () => {
  const { transport, instance, from, connection, trace } = await aboutToResume();
  const behind: (() => void)[] = [];
  const drain = (): void => {
    const pending = behind.splice(0, behind.length);
    for (const late of pending) late();
  };
  const subscribe = transport.subscribe.bind(transport);
  vi.spyOn(transport, "subscribe").mockImplementation((listener, options) =>
    subscribe((entry) => behind.push(() => listener(entry)), options),
  );
  publishingDuringRead(transport, { before: [message("chat:42", { text: "mid-replay" })] });

  await (await instance.open(connection, { after: from })).start();
  drain();
  await transport.publish(message("chat:42", { text: "live" }));
  drain();

  expect(trace).toEqual(["chat:42 missed", "chat:42 mid-replay", "caught-up", "chat:42 live"]);
});

test("a client that goes away mid-replay stops it, rather than paging the rest of the log", async () => {
  const transport = createMemoryTransport();
  const instance = getInstance({ transport });
  const from = await transport.tail();
  for (let n = 0; n < 1201; n += 1) {
    await transport.publish(message("chat:42", { text: `n${String(n)}` }));
  }

  /** The Connection closes itself in the middle of the replay, the way an abort does. */
  const leaving: { close?: () => void } = {};
  const trace: string[] = [];
  const connection: Connection = {
    channels: new Set(["chat:42"]),
    deliver: (entry) => {
      trace.push((entry.payload as Text).text);
      if (trace.length === 500) leaving.close?.();
    },
    reset: () => trace.push("reset"),
    caughtUp: () => trace.push("caught-up"),
  };

  const opening = await instance.open(connection, { after: from });
  leaving.close = opening.close;
  const reads = vi.spyOn(transport, "read");
  await opening.start();

  expect(trace).toHaveLength(500);
  expect(trace).not.toContain("caught-up");
  expect(reads).not.toHaveBeenCalled();
  expect(instance.connections.size).toBe(0);
});
