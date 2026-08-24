import { expect, test, vi } from "vitest";

import type { Entry, Transport } from "../transport/index.js";

import { selectTransport } from "./select-transport.js";

const message: Entry = {
  v: 1,
  type: "message",
  channel: "chat:42",
  event: "message",
  payload: { text: "one" },
};

/** A stand-in for the Redis module, so the selection can be tested without a server. */
const fakeRedis = (): { load: () => Promise<typeof import("../transport/redis.js")> } => {
  const transport = {
    publish: vi.fn(async () => "1-0"),
    read: vi.fn(async () => ({ entries: [], done: true })),
    tail: vi.fn(async () => "1-0"),
    subscribe: vi.fn(async () => () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Transport;

  return {
    load: vi.fn(async () => ({
      createRedisTransport: () => transport,
      createRedisPublisher: () => transport,
    })),
  };
};

test("an environment with no REDIS_URL gets the Memory Transport, and loads nothing else", async () => {
  const redis = fakeRedis();

  const transport = selectTransport({ env: {}, load: redis.load });
  const cursor = await transport.publish(message);

  expect(await transport.read(undefined, 10)).toEqual({
    entries: [{ ...message, cursor }],
    done: true,
  });
  expect(redis.load).not.toHaveBeenCalled();
});

/** Retention is configuration of both shipped Transports, so the Memory path honours it too. */
test("the retention the environment names bounds the Memory Transport as well", async () => {
  const transport = selectTransport({ env: { NEXT_SSE_RETENTION_CAP: "1" } });

  await transport.publish(message);
  const second = await transport.publish(message);

  expect(await transport.read(undefined, 10)).toEqual({
    entries: [{ ...message, cursor: second }],
    done: true,
  });
});

test("an environment with REDIS_URL gets the Redis Transport, loaded on first use", async () => {
  const redis = fakeRedis();

  const transport = selectTransport({ env: { REDIS_URL: "redis://host:6379" }, load: redis.load });
  expect(redis.load).not.toHaveBeenCalled();

  expect(await transport.publish(message)).toBe("1-0");
  expect(redis.load).toHaveBeenCalledTimes(1);

  await transport.tail();
  expect(redis.load).toHaveBeenCalledTimes(1);
});

/** A process that built an Instance and shut down without a Connection loads no client at all. */
test("closing a Transport that was never used loads nothing", async () => {
  const redis = fakeRedis();

  const transport = selectTransport({ env: { REDIS_URL: "redis://host:6379" }, load: redis.load });
  await transport.close();

  expect(redis.load).not.toHaveBeenCalled();
});

test("a value the environment cannot mean is refused before any Transport is chosen", () => {
  expect(() => selectTransport({ env: { NEXT_SSE_RETENTION_CAP: "lots" } })).toThrow(
    /NEXT_SSE_RETENTION_CAP/,
  );
});
