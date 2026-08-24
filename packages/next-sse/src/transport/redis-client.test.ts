import { createClient, createCluster, createSentinel } from "redis";
import { expect, expectTypeOf, test, vi } from "vitest";

import {
  clientKind,
  createRedisLink,
  reconnectDelay,
  type ClusterClientLike,
  type RedisClientLike,
  type SentinelClientLike,
  type StandaloneClientLike,
} from "./redis-client.js";

const KEY = "{next-sse}:log";

/** The three real clients, built but never connected: constructing one talks to nothing. */
const standalone = () => createClient({ url: "redis://127.0.0.1:6379" });
const cluster = () => createCluster({ rootNodes: [{ url: "redis://127.0.0.1:6379" }] });
const sentinel = () =>
  createSentinel({ name: "mymaster", sentinelRootNodes: [{ host: "127.0.0.1", port: 26379 }] });

/**
 * The check that decides how every command is handed over. It runs against the real classes so
 * that a node-redis release renaming what it reads breaks this test rather than a deployment's
 * Kick routing.
 */
test("each of the three node-redis clients is recognised for what it is", () => {
  expect(clientKind(standalone())).toBe("standalone");
  expect(clientKind(cluster())).toBe("cluster");
  expect(clientKind(sentinel())).toBe("sentinel");
});

/**
 * The narrow structural view has to describe the real clients, or injection is a fiction. The
 * assertion is the assignment itself: a node-redis release that moves what the Transport uses
 * fails this file at `typecheck`.
 */
const accepts = <Client>(client: Client): Client => client;

test("a real client of each kind satisfies the structural view the Transport takes of it", () => {
  expect(accepts<StandaloneClientLike>(standalone())).toBeDefined();
  expect(accepts<ClusterClientLike>(cluster())).toBeDefined();
  expect(accepts<SentinelClientLike>(sentinel())).toBeDefined();
  expectTypeOf<StandaloneClientLike>().toExtend<RedisClientLike>();
});

test("the reconnect delay always answers a delay, however many attempts have failed", () => {
  for (const retries of [0, 1, 5, 10, 100, 1000]) {
    const delay = reconnectDelay(retries);
    expect(typeof delay).toBe("number");
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(350);
  }
  expect(reconnectDelay(0)).toBeLessThan(reconnectDelay(6));
});

/** A client of each kind, recording what `sendCommand` was handed. */
function recorder(kind: "standalone" | "cluster" | "sentinel") {
  const calls: unknown[][] = [];
  const listeners = new Map<string, unknown>();
  const base = {
    sendCommand: (...args: unknown[]) => {
      calls.push(args);

      return Promise.resolve("OK");
    },
    duplicate: () => base,
    on: (event: string, listener: unknown) => listeners.set(event, listener),
    off: (event: string) => listeners.delete(event),
  };
  const client = {
    ...base,
    ...(kind === "cluster" ? { nodeClient: () => undefined } : {}),
    ...(kind === "sentinel" ? { use: () => undefined } : {}),
  } as unknown as RedisClientLike;

  return { client, calls, listeners };
}

test("a command is handed to each kind the way that kind takes it", async () => {
  const cases = [
    { kind: "standalone" as const, expected: [["PING"]] },
    { kind: "sentinel" as const, expected: [false, ["PING"]] },
    { kind: "cluster" as const, expected: [KEY, false, ["PING"]] },
  ];

  for (const { kind, expected } of cases) {
    const { client, calls } = recorder(kind);
    const link = createRedisLink({ client, key: KEY, onError: () => undefined });

    await link.send(["PING"]);

    expect(calls).toEqual([expected]);
  }
});

/**
 * One long-lived client feeding several Transports must not collect a listener per Transport,
 * and must survive the Transports it fed: closing a Transport closes nothing of the caller's.
 */
test("an injected client keeps its listener only while the link holds it, and is never closed", async () => {
  const { client, listeners } = recorder("standalone");
  const close = vi.fn();
  Object.assign(client, { close });

  const link = createRedisLink({ client, key: KEY, onError: () => undefined });
  expect(listeners.has("error")).toBe(true);

  await link.close();

  expect(listeners.has("error")).toBe(false);
  expect(close).not.toHaveBeenCalled();
});

/** The `error` node-redis emits outside any operation crashes the process without a listener. */
test("a failure of the connection itself is reported as a connect failure", () => {
  const { client, listeners } = recorder("standalone");
  const onError = vi.fn();

  createRedisLink({ client, key: KEY, onError });
  (listeners.get("error") as (error: unknown) => void)(new Error("socket closed"));

  expect(onError).toHaveBeenCalledWith(expect.any(Error), "connect");
});
