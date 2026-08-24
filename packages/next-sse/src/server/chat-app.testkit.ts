import type { Cursor, Transport } from "../transport/index.js";
import { createMemoryTransport } from "../transport/memory.js";

import { asType, initSSE } from "./index.js";
import type { Kick } from "./kick.js";

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
  readonly name: string;
  publish(event: string, payload: unknown): Promise<Cursor>;
  message(payload: unknown): Promise<Cursor>;
}

export interface ChatApp {
  handlers: { GET: (request: Request) => Promise<Response> };
  chat(params?: Record<string, string>): ChatHandle;
  kick: Kick;
}

export interface ChatAppOptions {
  /** The log this App runs on. A Memory Transport of its own when none is given. */
  transport?: Transport;
  /** The lifecycle durations of ADR-0004, shortened through the App's own configuration. */
  heartbeat?: number;
  maxLifetime?: number;
  /**
   * What this App builds from a request, for the two decisions that read one. The Ctx is
   * `unknown` here for the same reason the Registry's own is: the testkit holds the App's
   * functions without knowing what they build, and the test that wrote them does.
   */
  context?: (request: Request) => unknown;
  /** How this App names the holder of a Connection: what a Kick addresses it by (ADR-0003). */
  key?: (ctx: never) => string | undefined;
  /**
   * Whether this Connection may have this room. Every room is public unless a scenario says
   * otherwise, which is what lets one flip an authorization mid-run and Kick to enforce it.
   */
  authorize?: (params: { roomId: string }, ctx: never) => boolean | Promise<boolean>;
}

export function chatApp({
  transport,
  context,
  key,
  authorize,
  ...lifecycle
}: ChatAppOptions = {}): ChatApp {
  const { channel, createSSE } = initSSE<unknown>({
    transport: transport ?? createMemoryTransport(),
    context,
    key: key as ((ctx: unknown) => string | undefined) | undefined,
    ...lifecycle,
  });

  return createSSE({
    chat: channel({
      pattern: "chat:{roomId}",
      events: { message: asType<{ text: string }>(), typing: asType<{ who: string }>() },
      authorize: (authorize ?? (() => true)) as (
        params: { roomId: string },
        ctx: unknown,
      ) => boolean | Promise<boolean>,
    }),
  }) as unknown as ChatApp;
}
