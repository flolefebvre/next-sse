import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, expect, inject, test } from "vitest";

import { chatApp, type ChatApp } from "../packages/next-sse/src/server/chat-app.testkit.js";
import { framesOf, type Frames } from "../packages/next-sse/src/server/frames.testkit.js";
import type { Cursor, Transport } from "../packages/next-sse/src/transport/index.js";
import { createRedisTransport } from "../packages/next-sse/src/transport/redis.js";

import { startTcpProxy, type TcpProxy } from "./tcp-proxy.js";

/**
 * What ADR-0004 asks of an Instance whose Transport went away mid-Connection, against a real
 * server behind a cuttable path: every Connection it holds stays open and heartbeating, with no
 * bound, and it serves them again by itself when the backend is back. Nothing closes, because
 * closing would turn one backend blip into a herd of reconnects against Instances that are
 * equally cut off — and a connect it cannot serve is answered `503` rather than half-served.
 *
 * The other half of the criterion — a `reset` when, and only when, the position the reader
 * resumes from is gone — is the Transport's `onGap`, exercised on a trimmed log by the contract
 * suite and wired to the Connection table in the Instance's own tests.
 */

const opened: Transport[] = [];
const proxies: TcpProxy[] = [];

beforeEach(() => {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  delete globals[Symbol.for("@flefebvre/next-sse")];
});

afterEach(async () => {
  for (const transport of opened.splice(0)) await transport.close().catch(() => undefined);
  for (const proxy of proxies.splice(0)) await proxy.close();
});

/**
 * One App on a log of its own, reached through a path this test can cut. The heartbeat is
 * shortened through the App's own configuration — the library has no test-only branch — and the
 * max lifetime is off, so nothing but the outage is in play.
 */
const anApp = async (): Promise<{ sse: ChatApp; proxy: TcpProxy }> => {
  const proxy = await startTcpProxy(inject("redisUrl"));
  proxies.push(proxy);

  const transport = createRedisTransport({
    url: proxy.url,
    prefix: `next-sse-test-${randomUUID().slice(0, 8)}`,
  });
  opened.push(transport);

  return { sse: chatApp({ transport, heartbeat: 100, maxLifetime: 0 }), proxy };
};

const connect = async (sse: ChatApp): Promise<Response> =>
  sse.handlers.GET(new Request("http://example.test/api/sse?channel=chat:42"));

/** A Connection past its opening sequence: `ready`, the retry, `caught-up`. */
const live = async (sse: ChatApp): Promise<Frames> => {
  const response = await connect(sse);
  expect(response.status).toBe(200);
  const frames = framesOf(response);
  expect((await frames.next()).event).toBe("ready");
  expect(await frames.next()).toEqual({ retry: "3000" });
  expect((await frames.next()).event).toBe("caught-up");

  return frames;
};

/**
 * The next Message on the wire, with the heartbeats that keep coming in between skipped: this
 * Connection is heartbeated ten times a second, and the point of the case is what falls among
 * them, not how many of them there are.
 */
const nextMessage = async (frames: Frames): Promise<{ id?: string; data?: string }> => {
  for (;;) {
    const frame = await frames.next();
    if (frame.event === undefined) return frame;
    expect(frame.event).toBe("heartbeat");
  }
};

/** Publish until the Transport takes it, so that recovery is waited for rather than timed. */
const publishOnceBack = async (sse: ChatApp, text: string): Promise<Cursor> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await sse.chat({ roomId: "42" }).message({ text });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
};

test("a Transport outage holds every Connection open and heartbeating, and answers 503", async () => {
  const { sse, proxy } = await anApp();
  const frames = await live(sse);

  proxy.cut();

  /**
   * The pipe is still there, and still saying so: the heartbeat is the Instance's own timer,
   * owing the backend nothing, which is exactly why a client can tell a held Connection from a
   * dead one while the backend is away.
   */
  expect((await frames.next()).event).toBe("heartbeat");
  expect((await frames.next()).event).toBe("heartbeat");

  /**
   * A connect during the outage is refused with a status rather than registered on an Instance
   * that cannot serve it — which is also what lets a load balancer route it somewhere else.
   */
  const refused = await connect(sse);
  expect(refused.status).toBe(503);
  expect(refused.headers.get("Retry-After")).toBe("5");
  expect((await refused.text()).length).toBeGreaterThan(0);

  proxy.restore();

  /**
   * The Connection that was held is the one that is served: no reconnect, no replay, no `reset`
   * — the reader resumed where it was, and the next Message simply arrives.
   */
  const cursor = await publishOnceBack(sse, "after the outage");
  const delivered = await nextMessage(frames);

  expect(delivered.id).toBe(cursor);
  expect(JSON.parse(delivered.data ?? "{}")).toEqual({
    channel: "chat:42",
    event: "message",
    payload: { text: "after the outage" },
  });

  const again = await connect(sse);
  expect(again.status).toBe(200);
  await framesOf(again).cancel();
  await frames.cancel();
});
