import type { Cursor, Transport } from "../transport/index.js";
import { createMemoryTransport } from "../transport/memory.js";

import { asType, initSSE } from "./index.js";

/**
 * The one-Channel App every test about Connections is written against: the handler's own unit
 * tests, the gap-free scenarios and the Transport-outage one all drive this same Registry.
 *
 * It lives beside the code rather than in a test file because three suites build it, and a
 * second declaration of "the chat App" is a second opinion on what these tests are about. The
 * Registry is loosely typed here — the types the App would really get are the typing ticket's —
 * so the shape below is the runtime shape those types describe. The `.testkit.` in the name is
 * what keeps it out of the tarball, the way it keeps the frame reader out.
 */
export interface ChatHandle {
  publish(event: string, payload: unknown): Promise<Cursor>;
  message(payload: unknown): Promise<Cursor>;
}

export interface ChatApp {
  handlers: { GET: (request: Request) => Promise<Response> };
  chat(params?: Record<string, string>): ChatHandle;
}

export interface ChatAppOptions {
  /** The log this App runs on. A Memory Transport of its own when none is given. */
  transport?: Transport;
  /** The lifecycle durations of ADR-0004, shortened through the App's own configuration. */
  heartbeat?: number;
  maxLifetime?: number;
}

export function chatApp({ transport, ...lifecycle }: ChatAppOptions = {}): ChatApp {
  const { channel, createSSE } = initSSE({
    transport: transport ?? createMemoryTransport(),
    ...lifecycle,
  });

  return createSSE({
    chat: channel({
      pattern: "chat:{roomId}",
      events: { message: asType<{ text: string }>(), typing: asType<{ who: string }>() },
      authorize: () => true,
    }),
  }) as unknown as ChatApp;
}
