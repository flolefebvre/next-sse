import { afterEach, expect, test, vi } from "vitest";

import { TransportClosedError, TransportError, type Entry } from "./index.js";
import type { RedisClientLike, RedisErrorHook } from "./redis-client.js";
import { createRedisPublisher, createRedisTransport } from "./redis.js";

const message: Entry = {
  v: 1,
  type: "message",
  channel: "chat:42",
  event: "message",
  payload: { text: "one" },
};

/**
 * The environment is process-wide, and a Vitest worker runs several files: what a test here
 * stubs is taken back before the next one, in this file or any other.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

/** What the fake server answers, per command, and what it was asked. */
interface FakeServer {
  client: RedisClientLike;
  commands: string[][];
  info: { lastGeneratedId: string; firstEntryId: string; length: number; entriesAdded: number };
  entries: [string, string[]][];
  /** What an `XRANGE` from a position answers, which is what a paging test drives. */
  pageOf: (args: string[]) => [string, string[]][];
}

/**
 * A node-redis client that answers out of memory. It is what lets the command shapes of
 * ADR-0006 — the cap on every `XADD`, the exclusive `XRANGE`, the `XINFO STREAM` boundary — be
 * pinned without a server, and it never lets the reader connection start: nothing here
 * subscribes.
 */
function fakeServer(): FakeServer {
  const server: FakeServer = {
    client: undefined as unknown as RedisClientLike,
    commands: [],
    info: { lastGeneratedId: "7-0", firstEntryId: "3-0", length: 2, entriesAdded: 5 },
    entries: [],
    pageOf: () => server.entries,
  };

  server.client = {
    sendCommand: (args: string[]): Promise<unknown> => {
      server.commands.push(args);

      if (args[0] === "XADD") return Promise.resolve("9-0");
      if (args[0] === "XRANGE") return Promise.resolve(server.pageOf(args));
      if (args[0] === "XINFO") {
        return Promise.resolve([
          "length",
          String(server.info.length),
          "entries-added",
          String(server.info.entriesAdded),
          "last-generated-id",
          server.info.lastGeneratedId,
          "recorded-first-entry-id",
          server.info.firstEntryId,
        ]);
      }

      return Promise.resolve(null);
    },
    duplicate: () => {
      throw new Error("no reader is opened by these tests");
    },
    on: () => undefined,
    off: () => undefined,
  } as unknown as RedisClientLike;

  return server;
}

/** A Transport on the fake server, hearing about every failure it meets. */
const transportOf = (server: FakeServer, onError?: RedisErrorHook) =>
  createRedisTransport({ client: server.client, ...(onError === undefined ? {} : { onError }) });

/** The arguments of the one command of this name that was sent. */
const commandOf = (server: FakeServer, name: string): string[] =>
  server.commands.find((args) => args[0] === name) ?? [];

test("a Publish is one XADD, capped, carrying the envelope in the one entry field", async () => {
  const server = fakeServer();
  const transport = createRedisTransport({
    client: server.client,
    prefix: "my-app",
    retention: { cap: 500 },
  });

  expect(await transport.publish(message)).toBe("9-0");
  expect(commandOf(server, "XADD")).toEqual([
    "XADD",
    "{my-app}:log",
    "MAXLEN",
    "~",
    "500",
    "*",
    "entry",
    JSON.stringify(message),
  ]);
});

test("a read pages strictly after the Cursor it was given", async () => {
  const server = fakeServer();
  const transport = createRedisTransport({ client: server.client, prefix: "my-app" });

  await transport.read("4-0", 100);

  expect(commandOf(server, "XRANGE")).toEqual([
    "XRANGE",
    "{my-app}:log",
    "(4-0",
    "+",
    "COUNT",
    "100",
  ]);
});

test("a read without a Cursor asks the log for its start", async () => {
  const server = fakeServer();
  const transport = createRedisTransport({ client: server.client });

  await transport.read(undefined, 10);

  expect(commandOf(server, "XRANGE")[2]).toBe("-");
});

/**
 * A log only ever drops from its front, so a Cursor at or above the oldest Entry it still holds
 * has lost nothing after it, and one below it has (ADR-0006, corrected: `max-deleted-entry-id`
 * is not maintained by trimming on either Redis 8 or Valkey 8).
 */
test("gone is decided by the oldest Entry the log holds, not by what came back", async () => {
  const server = fakeServer();
  const transport = createRedisTransport({ client: server.client });

  expect(await transport.read("2-0", 10)).toEqual({ gone: true });
  expect(await transport.read("3-0", 10)).toEqual({ entries: [], done: true });
});

test("a Cursor no Stream could have minted is gone, and asks the server nothing", async () => {
  const server = fakeServer();
  const transport = createRedisTransport({ client: server.client });

  expect(await transport.read("", 10)).toEqual({ gone: true });
  expect(await transport.read("not-a-cursor", 10)).toEqual({ gone: true });
  expect(server.commands).toEqual([]);
});

test("tail is the last ID the log generated, without writing anything", async () => {
  const server = fakeServer();
  const transport = createRedisTransport({ client: server.client });

  expect(await transport.tail()).toBe("7-0");
  expect(server.commands.every((args) => args[0] === "XINFO")).toBe(true);
});

/** A stream nothing was ever published to is a log at its first position, not a failure. */
test("a log whose key does not exist yet answers the position before anything", async () => {
  const server = fakeServer();
  server.client.sendCommand = () => Promise.reject(new Error("ERR no such key"));
  const transport = createRedisTransport({ client: server.client });

  expect(await transport.tail()).toBe("0-0");
});

test("an Entry the log cannot read is skipped, and reported once", async () => {
  const server = fakeServer();
  const onError = vi.fn();
  server.entries = [
    ["4-0", ["entry", "{ not json"]],
    ["5-0", ["entry", JSON.stringify(message)]],
  ];
  const transport = createRedisTransport({ client: server.client, onError });

  const page = await transport.read("3-0", 10);

  expect(page).toEqual({ entries: [{ ...message, cursor: "5-0" }], done: true });
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith(expect.any(TransportError), "read");
});

/**
 * A page whose every Entry is unreadable carries no Cursor to page on from, so a caller would
 * ask for the same page for ever. The Transport walks past it itself.
 */
test("a page of nothing but unreadable Entries is walked past, not answered", async () => {
  const server = fakeServer();
  const onError = vi.fn();
  const unreadable: [string, string[]][] = [
    ["4-0", ["entry", "{ not json"]],
    ["5-0", ["entry", "{ not json either"]],
  ];
  server.info = { lastGeneratedId: "6-0", firstEntryId: "3-0", length: 4, entriesAdded: 4 };
  server.pageOf = (args) =>
    args[2] === "(3-0" ? unreadable : [["6-0", ["entry", JSON.stringify(message)]]];

  const page = await transportOf(server, onError).read("3-0", 2);

  expect(page).toEqual({ entries: [{ ...message, cursor: "6-0" }], done: true });
  expect(onError).toHaveBeenCalledTimes(2);
  expect(server.commands.filter((args) => args[0] === "XRANGE").map((args) => args[2])).toEqual([
    "(3-0",
    "(5-0",
  ]);
});

test("a closed Transport answers nothing further, and closing twice is not an error", async () => {
  const transport = createRedisTransport({ client: fakeServer().client });

  await transport.close();
  await transport.close();

  await expect(transport.publish(message)).rejects.toBeInstanceOf(TransportClosedError);
  await expect(transport.read(undefined, 10)).rejects.toBeInstanceOf(TransportClosedError);
  await expect(transport.tail()).rejects.toBeInstanceOf(TransportClosedError);
  await expect(
    transport.subscribe(() => undefined, { onGap: () => undefined }),
  ).rejects.toBeInstanceOf(TransportClosedError);
});

test("what the factory is given wins over what the environment says, field by field", async () => {
  vi.stubEnv("NEXT_SSE_PREFIX", "from-the-environment");
  vi.stubEnv("NEXT_SSE_RETENTION_CAP", "42");
  const server = fakeServer();

  const fromEnvironment = createRedisTransport({ client: server.client });
  await fromEnvironment.publish(message);
  expect(commandOf(server, "XADD").slice(1, 5)).toEqual([
    "{from-the-environment}:log",
    "MAXLEN",
    "~",
    "42",
  ]);

  const configured = createRedisTransport({ client: server.client, prefix: "explicit" });
  server.commands.length = 0;
  await configured.publish(message);
  expect(commandOf(server, "XADD").slice(1, 5)).toEqual(["{explicit}:log", "MAXLEN", "~", "42"]);
});

test("a Transport with no server to talk to says so, naming what it needs", () => {
  vi.stubEnv("REDIS_URL", "");

  expect(() => createRedisTransport()).toThrow(/pass `url` or `client`, or set `REDIS_URL`/);
});

test("a Prefix that would break the key is refused by the factory", () => {
  expect(() => createRedisTransport({ client: fakeServer().client, prefix: "{app}" })).toThrow(
    TransportError,
  );
});

/** The Publisher is the same log narrowed: it Publishes and reads the tail, and nothing else. */
test("the Publisher publishes into the very same log", async () => {
  const server = fakeServer();
  const publisher = createRedisPublisher({ client: server.client, prefix: "my-app" });

  expect(await publisher.publish(message)).toBe("9-0");
  expect(commandOf(server, "XADD")[1]).toBe("{my-app}:log");
  expect(await publisher.tail()).toBe("7-0");
  await publisher.close();
  expect("subscribe" in publisher).toBe(false);
});
