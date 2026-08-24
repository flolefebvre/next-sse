import { beforeEach, expect, test, vi } from "vitest";

import type { ChannelRecord } from "../internal/channel.js";
import { createMemoryTransport } from "../transport/memory.js";
import { TransportUnavailableError } from "../transport/index.js";
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
  reconnect: vi.fn<() => void>(),
});

/** The same Connection, with the Key its App gave it: what a Kick addresses it by. */
const keyed = (key: string, ...channels: string[]): Connection => ({
  ...connectionOn(...channels),
  key,
});

/** One Kick, as it travels the log: a control Entry naming a Key, a Channel, or neither. */
const kick = (target: { key?: string; channel?: string }): Entry => ({
  v: 1,
  type: "control",
  control: "kick",
  ...target,
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
      reconnect: () => trace.push("reconnect"),
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

/**
 * Two Connections that overlap on one Channel: one holding both rooms, one holding only the
 * second. It is the fixture behind both "reaches the Connections it names" claims — a Message's
 * and a Kick's — which is why it is named once rather than written twice.
 */
const twoOverlapping = async (): Promise<{
  instance: Instance;
  subscribed: Connection;
  elsewhere: Connection;
}> => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const subscribed = connectionOn("chat:42", "chat:7");
  const elsewhere = connectionOn("chat:7");
  await live(instance, subscribed);
  await live(instance, elsewhere);

  return { instance, subscribed, elsewhere };
};

test("a Message reaches the Connections subscribed to its Channel, and no others", async () => {
  const { instance, subscribed, elsewhere } = await twoOverlapping();

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
  await instance.transport.publish(kick({ key: "user-7" }));

  expect(connection.deliver).not.toHaveBeenCalled();
  expect(connection.reconnect).not.toHaveBeenCalled();
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

/**
 * A replayed Kick is a Kick that has already happened: acting on it would drop a Connection the
 * fresh Authorize has just let back in, which is why control entries are live-only (ADR-0003).
 * The Kick below names the very Channel this Connection carries, so a replay that acted on it
 * would show as a `reconnect` in the trace.
 */
test("replay carries no control Entry and no Channel the Connection did not name", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const from = await instance.transport.tail();
  await instance.transport.publish(kick({ channel: "chat:42" }));
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
    reconnect: () => leaving.close?.(),
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

/**
 * The two durations of ADR-0004, as the Instance resolves them: the App's value, or the default
 * when it configured none. `0` is a value — the feature off — and never a stand-in for "use the
 * default", which is what makes `heartbeat: 0` a Connection with no heartbeat at all.
 */
test("the lifecycle durations are the App's, or the defaults, with 0 meaning off", () => {
  expect(getInstance()).toMatchObject({ heartbeat: 15_000, maxLifetime: 30 * 60_000 });
  expect(getInstance({ heartbeat: 0, maxLifetime: 0 })).toMatchObject({
    heartbeat: 0,
    maxLifetime: 0,
  });
  expect(getInstance({ heartbeat: 250 })).toMatchObject({
    heartbeat: 250,
    maxLifetime: 30 * 60_000,
  });
});

/**
 * Handed to `setTimeout`, a negative delay fires at once and `NaN` fires at once too, so a
 * mistyped option would become every Connection ending the instant it opened. It is refused
 * where it is written instead.
 */
test.each([
  ["a negative interval", { heartbeat: -1 }],
  ["an interval that is no number at all", { maxLifetime: Number.NaN }],
])("%s is refused at the configuration rather than armed", (_case, options) => {
  expect(() => getInstance(options)).toThrow(/milliseconds/);
});

/**
 * A Transport whose live feed can be made to lose its place, the way a reader resuming after an
 * outage does when the log has moved past where it was.
 */
const withGap = (): { transport: Transport; gap: () => void } => {
  const memory = createMemoryTransport();
  let lostPlace: (() => void) | undefined;

  return {
    transport: {
      ...memory,
      subscribe: (listener, options) => {
        lostPlace = options.onGap;

        return memory.subscribe(listener, options);
      },
    },
    gap: () => lostPlace?.(),
  };
};

/**
 * The Transport came back somewhere the log no longer serves, so every Connection this Instance
 * holds is behind a gap nobody can describe: they are told to refetch, and not one of them is
 * closed. Closing would turn a backend blip into a herd against Instances equally cut off
 * (ADR-0004).
 */
test("a gap on the live feed tells every live Connection to refetch, and closes none", async () => {
  const { transport, gap } = withGap();
  const instance = getInstance({ transport });
  const one = tracing("chat:42");
  const other = tracing("chat:7");
  await (await instance.open(one.connection)).start();
  await (await instance.open(other.connection)).start();

  gap();

  expect(one.trace).toEqual(["caught-up", "reset"]);
  expect(other.trace).toEqual(["caught-up", "reset"]);
  expect(instance.connections.size).toBe(2);
});

/**
 * A Connection that is still opening cannot be told anything: its `ready` has not been written
 * and its replay is still walking the log. The `reset` waits for the place a `reset` belongs —
 * the end of the replay, before `caught-up`.
 */
test("a gap while a Connection is still opening reaches it with its replay, never before", async () => {
  const { transport, gap } = withGap();
  const instance = getInstance({ transport });
  const from = await transport.tail();
  await transport.publish(message("chat:42", { text: "missed" }));
  const { connection, trace } = tracing("chat:42");

  const opening = await instance.open(connection, { after: from });
  gap();
  expect(trace).toEqual([]);

  await opening.start();

  expect(trace).toEqual(["chat:42 missed", "reset", "caught-up"]);
});

/**
 * The subscription is opened once and remembered, and a rejected promise must not be what is
 * remembered: the Transport rejects for as long as the backend is away, and the first connect
 * of an outage would otherwise be the answer to every connect for the length of the process.
 */
test("a subscription that could not be opened is not remembered", async () => {
  const memory = createMemoryTransport();
  let away = true;
  const transport: Transport = {
    ...memory,
    subscribe: (listener, options) => {
      if (away) throw new TransportUnavailableError("the backend is away");

      return memory.subscribe(listener, options);
    },
  };
  const instance = getInstance({ transport });

  await expect(instance.open(connectionOn("chat:42"))).rejects.toThrow(TransportUnavailableError);
  expect(instance.connections.size).toBe(0);

  away = false;
  const opening = await instance.open(connectionOn("chat:42"));

  expect(opening.cursor).toBe(await transport.tail());
  expect(instance.connections.size).toBe(1);
});

/**
 * Past the 32-bit delay a timer takes, `setTimeout` fires almost at once: a 30-day `maxLifetime`
 * would be every Connection ending on the spot rather than in a month. The value is refused
 * rather than quietly turned into its opposite.
 */
test("a duration longer than a timer can hold is refused, not silently inverted", () => {
  expect(() => getInstance({ maxLifetime: 30 * 24 * 60 * 60_000 })).toThrow(/about 24 days/);
  expect(getInstance({ maxLifetime: 2_147_483_647 })).toMatchObject({
    maxLifetime: 2_147_483_647,
  });
});

/**
 * A Kick is a walk of the Connection table, matching on the field the Entry names, and the one
 * thing it does to a match is the one thing that ends a Connection at all: `reconnect` (ADR-0003).
 * It reaches this Instance the way every Entry does — off the log — which is how a Kick published
 * by one Instance ends the Connections every other Instance holds.
 */
test("a Kick by Key ends the Connections that Key holds, and no others", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const hers = keyed("ada", "chat:42");
  const alsoHers = keyed("ada", "chat:7");
  const his = keyed("sam", "chat:42");
  const anonymous = connectionOn("chat:42");
  for (const connection of [hers, alsoHers, his, anonymous]) await live(instance, connection);

  await instance.transport.publish(kick({ key: "ada" }));

  expect(hers.reconnect).toHaveBeenCalledTimes(1);
  expect(alsoHers.reconnect).toHaveBeenCalledTimes(1);
  expect(his.reconnect).not.toHaveBeenCalled();
  expect(anonymous.reconnect).not.toHaveBeenCalled();
});

/**
 * Kicking a Channel ends the whole Connection, not that one Channel of it: there is no way to
 * take a Channel off a live Connection, and there is no need for one — the client comes straight
 * back with its full Channel set and its Cursor, and Authorize settles what survives.
 */
test("a Kick by Channel ends every Connection subscribed to it, whatever else it carries", async () => {
  const { instance, subscribed, elsewhere } = await twoOverlapping();

  await instance.transport.publish(kick({ channel: "chat:42" }));

  expect(subscribed.reconnect).toHaveBeenCalledTimes(1);
  expect(elsewhere.reconnect).not.toHaveBeenCalled();
});

/**
 * A Connection is in the table before it is open, and a Kick walking that table has no reason to
 * skip it: the client is on the far end either way, and `reconnect` on a Connection that is still
 * opening is remembered and carried out after `ready` (ADR-0004). Skipping it would leave a
 * window — the width of a replay — in which a revocation silently misses.
 *
 * The Kick is acted on where it arrives and is never put in the buffer, which is what the rest of
 * the trace pins: the buffer this Connection drains when its replay ends holds the two Messages
 * and nothing else, each once and in the order the log carried them.
 */
test("a Kick reaches a Connection that is still opening, and never enters its buffer", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const { connection, trace } = tracing("chat:42");
  const opening = await instance.open({ ...connection, key: "ada" });

  await instance.transport.publish(message("chat:42", { text: "before the kick" }));
  await instance.transport.publish(kick({ key: "ada" }));
  await instance.transport.publish(message("chat:42", { text: "after the kick" }));
  await opening.start();

  expect(trace).toEqual([
    "reconnect",
    "caught-up",
    "chat:42 before the kick",
    "chat:42 after the kick",
  ]);
});

/**
 * A Kick that names neither a Key nor a Channel names no Connection. Something else writing this
 * App's log, or a later library meaning something by it, must not read as "end everything".
 */
test("a Kick that names neither a Key nor a Channel ends nothing", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const connection = keyed("ada", "chat:42");
  await live(instance, connection);

  await instance.transport.publish(kick({}));

  expect(connection.reconnect).not.toHaveBeenCalled();
});
