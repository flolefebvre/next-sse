import { randomUUID } from "node:crypto";

import { afterEach, expect, inject, test } from "vitest";

import type { Entry, Transport } from "../packages/next-sse/src/transport/index.js";
import { createRedisTransport } from "../packages/next-sse/src/transport/redis.js";

/**
 * What the contract cannot ask of a log, because it is about a server two logs share: the
 * Prefix is the only thing keeping two Apps apart (ADR-0006), and the time window is enforced
 * against the server's clock by the readers rather than by any stream primitive.
 */

const message = (text: string): Entry => ({
  v: 1,
  type: "message",
  channel: "chat:42",
  event: "message",
  payload: { text },
});

const opened: Transport[] = [];

const transport = (prefix: string, options: { window?: number } = {}): Transport => {
  const created = createRedisTransport({
    url: inject("redisUrl"),
    prefix,
    ...(options.window === undefined ? {} : { retention: { window: options.window } }),
  });
  opened.push(created);

  return created;
};

const prefix = (): string => `next-sse-test-${randomUUID().slice(0, 8)}`;

afterEach(async () => {
  for (const open of opened.splice(0)) await open.close().catch(() => undefined);
});

/** Wait for something the log does, never for a duration. */
const until = async (holds: () => Promise<boolean>, description: string): Promise<void> => {
  const deadline = Date.now() + 15_000;

  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/**
 * The hazard the docs are meant to name: two Apps under one Prefix are one App as far as the
 * log is concerned, and two Apps under two Prefixes share nothing but the server.
 */
test("the Prefix is the only thing keeping two Apps on one server apart", async () => {
  const shared = prefix();
  const one = transport(shared);
  const alsoOne = transport(shared);
  const other = transport(prefix());

  const cursor = await one.publish(message("from the first App"));

  expect((await alsoOne.read(undefined, 10)) as unknown).toEqual({
    entries: [{ ...message("from the first App"), cursor }],
    done: true,
  });
  expect((await other.read(undefined, 10)) as unknown).toEqual({ entries: [], done: true });
});

/**
 * The window is trimmed by the readers, on a period of their own: there is no time-based stream
 * primitive, so a log nobody reads keeps what the cap allows and no less (ADR-0006). The
 * subscription is what starts that trimming here, and the interval follows the window — half of
 * it, up to a minute — so a short window is trimmed soon rather than in a minute's time.
 */
test("the time window empties a log the App has stopped publishing to", async () => {
  const log = transport(prefix(), { window: 1 });
  const first = await log.publish(message("older than the window"));
  const second = await log.publish(message("older than the window too"));
  await log.subscribe(() => undefined, { onGap: () => undefined });

  await until(async () => {
    const page = await log.read(undefined, 10);

    return "gone" in page || page.entries.length === 0;
  }, "the window emptied the log");

  /**
   * A log the window emptied has dropped everything it held, so a Cursor with an Entry after it
   * is gone — the branch where the oldest position the log serves is the one it reached, not the
   * oldest Entry it holds, since it holds none. The last position it ever minted lost nothing
   * after it, and still reads.
   */
  expect(await log.read(first, 10)).toEqual({ gone: true });
  expect(await log.read(second, 10)).toEqual({ entries: [], done: true });
  expect(await log.tail()).toBe(second);
  expect(await log.read(await log.tail(), 10)).toEqual({ entries: [], done: true });
});

/**
 * A reader is always sitting inside a five-second `XREAD BLOCK`, and node-redis's `close()`
 * waits for the commands in flight: draining that connection would make every `close()` take up
 * to a whole block — on a Drain (ADR-0011), on a hot reload, and on every case of the contract
 * suite. The reader connection is this Transport's own and is owed no graceful end, so it is
 * torn down instead.
 */
test("closing a Transport with a live reader does not wait out its blocking read", async () => {
  const log = transport(prefix());
  await log.subscribe(() => undefined, { onGap: () => undefined });
  await log.publish(message("something to have read"));

  const startedAt = Date.now();
  await log.close();

  expect(Date.now() - startedAt).toBeLessThan(500);
});
