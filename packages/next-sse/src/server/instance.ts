import { createMemoryTransport } from "../transport/memory.js";
import type { StoredEntry, Transport, Unsubscribe } from "../transport/index.js";

import type { StoredMessage } from "./wire.js";

/**
 * Where the Instance lives. A `Symbol.for` slot on `globalThis` costs nothing in production
 * and is what keeps one Transport, one Connection table and one Registry across the module
 * re-evaluations Turbopack does on every request after an edit (ADR-0004): without it a
 * Publish from the new module instance would never reach a Connection held by the old one.
 */
const SLOT = Symbol.for("@flefebvre/next-sse");

/** One open SSE Connection, as the Instance sees it: what it listens to, and how to feed it. */
export interface Connection {
  /** The Channels this Connection subscribed to. */
  readonly channels: ReadonlySet<string>;
  /** Hand it one Message it is subscribed to. Must not throw. */
  deliver(entry: StoredMessage): void;
}

/** Everything one running Instance of an App owns. */
export interface Instance {
  /** The one log this Instance reads and Publishes into. */
  readonly transport: Transport;
  /** The Connections this Instance is holding open right now. */
  readonly connections: ReadonlySet<Connection>;
  /** The App's current Registry, as data: a re-evaluated `createSSE` swaps it. */
  registry: unknown;
  /** Register a Connection and start feeding it. The returned function unregisters it. */
  open(connection: Connection): Promise<Unsubscribe>;
}

interface InstanceState extends Instance {
  connections: Set<Connection>;
  feed: Promise<Unsubscribe> | undefined;
}

const globals = globalThis as unknown as { [key: symbol]: InstanceState | undefined };

/**
 * The Instance of this process, created on first use.
 *
 * A `transport` given on a later call is deliberately ignored: the whole point of the slot is
 * that a second evaluation of the App's Registry module — which builds a second Memory
 * Transport as it goes — keeps Publishing into the log the open Connections are reading.
 */
export function getInstance(options: { transport?: Transport } = {}): Instance {
  const existing = globals[SLOT];
  if (existing) return existing;

  const state: InstanceState = {
    transport: options.transport ?? createMemoryTransport(),
    connections: new Set(),
    registry: undefined,
    feed: undefined,
    async open(connection: Connection): Promise<Unsubscribe> {
      await ensureFeed(state);
      state.connections.add(connection);

      return () => {
        state.connections.delete(connection);
      };
    },
  };
  globals[SLOT] = state;

  return state;
}

/**
 * The one subscription this Instance holds, started with the first Connection: every Instance
 * reads the whole log once and routes what it reads itself (ADR-0005), rather than asking the
 * Transport for anything Channel-shaped.
 */
async function ensureFeed(state: InstanceState): Promise<void> {
  state.feed ??= state.transport.subscribe(
    (entry) => {
      route(state, entry);
    },
    {
      onGap: () => undefined,
    },
  );

  await state.feed;
}

/**
 * One Entry, to the Connections that asked for its Channel. An Entry no Connection here
 * subscribes to is dropped for free — during a rolling deploy an Instance legitimately reads
 * Channels it knows nothing about.
 */
function route(state: InstanceState, entry: StoredEntry): void {
  if (entry.type !== "message") return;

  for (const connection of state.connections) {
    if (connection.channels.has(entry.channel)) connection.deliver(entry);
  }
}
