import { randomUUID } from "node:crypto";

import {
  chatApp,
  type ChatApp,
  type ChatAppOptions,
} from "../packages/next-sse/src/server/chat-app.testkit.js";
import type { Transport } from "../packages/next-sse/src/transport/index.js";
import { framesOf, messageOf, type Frame } from "../packages/next-sse/src/server/frames.testkit.js";
import type { Cursor } from "../packages/next-sse/src/transport/index.js";
import { createRedisTransport } from "../packages/next-sse/src/transport/redis.js";

/** Two Instances of one App, and the Transports they hold. */
export interface TwoInstances {
  /** The Instance a client is connected to. */
  here: ChatApp;
  /** Another Instance of the same App, on the same log, which may hold Connections of its own. */
  there: ChatApp;
  /** Release both Transports. Every scenario owes this to the server it opened them on. */
  close(): Promise<void>;
}

/**
 * Two Instances of one App in one process, on one real log: the smallest thing that can prove
 * an Entry crosses Instances without booting Next.js twice (ADR-0009).
 *
 * They share a Prefix and nothing else — two Transports, two Connection tables, two
 * subscriptions — which is exactly the shape of two pods behind a load balancer. The Instance is
 * a `globalThis` slot (ADR-0004), so the slot is emptied between the two: each Registry stays
 * bound to the Instance object it was built on, and whichever is left in the slot afterwards
 * belongs to nobody.
 *
 * The Prefix is fresh per call, so one container serves a whole run and no scenario reads
 * another's log.
 */
export async function twoInstances(
  url: string,
  options: Omit<ChatAppOptions, "transport"> = {},
): Promise<TwoInstances> {
  const prefix = `next-sse-test-${randomUUID().slice(0, 8)}`;
  const transports: Transport[] = [];

  const anInstance = (): ChatApp => {
    emptyTheSlot();
    const transport = createRedisTransport({ url, prefix });
    transports.push(transport);

    return chatApp({ ...options, transport });
  };

  return {
    here: anInstance(),
    there: anInstance(),
    close: async () => {
      await Promise.all(transports.map((transport) => transport.close()));
      emptyTheSlot();
    },
  };
}

/** The `globalThis` slot the Instance lives in, as a fresh process would find it. */
export function emptyTheSlot(): void {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  delete globals[Symbol.for("@flefebvre/next-sse")];
}

/** One open Connection on one Instance, as a scenario reads it. */
export interface Client {
  /** Where this client stands: what `ready` gave it, moved on by every Message it receives. */
  cursor: Cursor;
  /** The Channels Authorize did not let through, as `ready` named them. */
  refused: string[];
  /** The next block off the wire, whatever it carries. */
  next(): Promise<Frame>;
  /** The next Message, refusing a Control event: its Channel, its text, and its Cursor kept. */
  message(): Promise<{ channel: string; text: string }>;
  /** The way this client goes away. */
  leave(): void;
}

/**
 * Open a Connection on one of the two Instances and read its opening sequence.
 *
 * It lives on the fixture rather than in a scenario because every scenario about two Instances
 * opens the same Connection — as a named user, on the room, sometimes resuming from a Cursor —
 * and a second spelling of it would be a second opinion on what a client does.
 */
export async function connect(
  sse: ChatApp,
  {
    user,
    after,
    channels = ["chat:42"],
  }: { user?: string; after?: Cursor; channels?: string[] } = {},
): Promise<Client> {
  const client = new AbortController();
  const headers: Record<string, string> = {};
  if (user !== undefined) headers["x-user"] = user;
  if (after !== undefined) headers["Last-Event-ID"] = after;

  const query = channels.map((name) => `channel=${name}`).join("&");
  const response = await sse.handlers.GET(
    new Request(`http://example.test/api/sse?${query}`, { signal: client.signal, headers }),
  );
  if (response.status !== 200) {
    throw new Error(`the Instance answered ${String(response.status)} rather than opening`);
  }

  const frames = framesOf(response);
  const ready = JSON.parse((await frames.next()).data ?? "{}") as {
    cursor: Cursor;
    refused: string[];
  };
  await frames.next();

  const state: Client = {
    cursor: ready.cursor,
    refused: ready.refused,
    next: () => frames.next(),
    message: async () => {
      const frame = await frames.next();
      state.cursor = frame.id ?? state.cursor;

      return messageOf(frame);
    },
    leave: () => {
      client.abort();
    },
  };

  return state;
}
