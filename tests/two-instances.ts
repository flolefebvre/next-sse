import { randomUUID } from "node:crypto";

import {
  chatApp,
  type ChatApp,
  type ChatAppOptions,
} from "../packages/next-sse/src/server/chat-app.testkit.js";
import type { Transport } from "../packages/next-sse/src/transport/index.js";
import { createRedisTransport } from "../packages/next-sse/src/transport/redis.js";

/** Two Instances of one App, and the Transports they hold. */
export interface TwoInstances {
  /** The Instance a client is connected to. */
  here: ChatApp;
  /** Another Instance of the same App, on the same log, holding no Connection of its own. */
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
