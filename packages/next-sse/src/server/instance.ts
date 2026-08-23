import { createMemoryTransport } from "../transport/memory.js";
import type { Cursor, StoredEntry, Transport, Unsubscribe } from "../transport/index.js";

import type { StoredMessage } from "./wire.js";

/**
 * Where the Instance lives. A `Symbol.for` slot on `globalThis` costs nothing in production
 * and is what keeps one Transport, one Connection table and one Registry across the module
 * re-evaluations Turbopack does on every request after an edit (ADR-0004): without it a
 * Publish from the new module instance would never reach a Connection held by the old one.
 */
const SLOT = Symbol.for("@flefebvre/next-sse");

/**
 * How many Entries one replay page asks the log for. Large enough that an ordinary reconnect
 * is one round trip, small enough that a Connection resuming from the far end of a busy log
 * starts writing before the whole window is in memory.
 */
const REPLAY_PAGE_SIZE = 500;

/** One open SSE Connection, as the Instance sees it: what it listens to, and how to feed it. */
export interface Connection {
  /** The Channels this Connection subscribed to. */
  readonly channels: ReadonlySet<string>;
  /** Hand it one Message it is subscribed to. Must not throw. */
  deliver(entry: StoredMessage): void;
  /** Its Cursor is unusable: the App must refetch its state before going on. Must not throw. */
  reset(): void;
  /** The replay is over and everything from here on is live. Must not throw. */
  caughtUp(): void;
}

/**
 * A Connection between being registered and being live. The two phases are what let the
 * handler write the opening sequence in order: it takes `cursor` for the `ready` event it
 * writes itself, and everything `start` produces — a `reset`, the replay, `caught-up` — comes
 * back through the Connection's own methods, after `ready` is out.
 */
export interface Opening {
  /** The Cursor this Connection resumes from: the one it asked for, or the log's tail. */
  readonly cursor: Cursor;
  /** Replay what this Connection missed, then hand it to the live feed. */
  start(): Promise<void>;
  /** Take the Connection out of the table. */
  close(): void;
}

/** Everything one running Instance of an App owns. */
export interface Instance {
  /** The one log this Instance reads and Publishes into. */
  readonly transport: Transport;
  /** The Connections this Instance is holding open right now. */
  readonly connections: ReadonlySet<Connection>;
  /** The App's current Registry, as data: a re-evaluated `createSSE` swaps it. */
  registry: unknown;
  /**
   * Register a Connection and start feeding it, resuming after `after` when it brought a
   * Cursor. Registering comes first, before the log is read at all: the live feed is buffered
   * from that moment, which is what makes the replay→live cut exact (ADR-0005).
   */
  open(connection: Connection, options?: { after?: Cursor }): Promise<Opening>;
}

/**
 * One Connection as the Instance holds it: itself, and the live Entries buffered while it is
 * still opening. A buffer of `undefined` is a Connection that has caught up and is live.
 */
interface Held {
  connection: Connection;
  buffer: StoredEntry[] | undefined;
}

interface InstanceState extends Instance {
  held: Map<Connection, Held>;
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
    held: new Map(),
    get connections(): ReadonlySet<Connection> {
      return new Set(state.held.keys());
    },
    registry: undefined,
    feed: undefined,
    open: (connection, openOptions) => open(state, connection, openOptions),
  };
  globals[SLOT] = state;

  return state;
}

/**
 * Registering a Connection is the first thing that happens, before `tail` and before the first
 * `read`: from here on every Entry the log carries is buffered for it, so whatever the replay
 * ends on is necessarily in that buffer and the handoff can be cut by Cursor equality alone.
 */
async function open(
  state: InstanceState,
  connection: Connection,
  { after }: { after?: Cursor } = {},
): Promise<Opening> {
  await ensureFeed(state);

  const held: Held = { connection, buffer: [] };
  state.held.set(connection, held);

  const close = (): void => {
    state.held.delete(connection);
  };

  try {
    /**
     * A Cursor the log cannot serve is not an error: the Connection resumes from the tail and
     * is told, in band, that it has to refetch (ADR-0004). A live-only connect adopts the same
     * tail, a read that writes nothing, so that a client which never received a Message still
     * reconnects from a position rather than from nothing.
     */
    const first =
      after === undefined ? undefined : await state.transport.read(after, REPLAY_PAGE_SIZE);
    const gone = first !== undefined && "gone" in first;
    const cursor = after !== undefined && !gone ? after : await state.transport.tail();

    return {
      cursor,
      start: () => replay(state, held, cursor, gone ? undefined : first, gone),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * Everything the Connection missed, then the live feed, with no gap and no duplicate between
 * them: replay pages strictly after the Cursor, the buffered live Entries cut up to and
 * including the last one replayed, `caught-up`, then whatever the buffer still holds.
 *
 * The Instance never orders two Cursors. The cut is an equality search in the buffer, and an
 * Entry the buffer does not carry is one published before this Connection was registered —
 * which nothing in the buffer can duplicate.
 */
async function replay(
  state: InstanceState,
  held: Held,
  cursor: Cursor,
  first: Awaited<ReturnType<Transport["read"]>> | undefined,
  gone: boolean,
): Promise<void> {
  if (gone) held.connection.reset();

  let last = cursor;
  let page = first;
  while (page !== undefined) {
    if ("gone" in page) {
      /**
       * The log dropped what this replay was walking through while it walked. There is no
       * Cursor left to resume from, so the Connection is told to refetch and carries on live.
       */
      held.connection.reset();
      break;
    }

    for (const entry of page.entries) {
      last = entry.cursor;
      if (entry.type === "message" && held.connection.channels.has(entry.channel)) {
        held.connection.deliver(entry);
      }
    }

    page = page.done ? undefined : await state.transport.read(last, REPLAY_PAGE_SIZE);
  }

  const buffered = held.buffer ?? [];
  const seen = buffered.findIndex((entry) => entry.cursor === last);
  const live = seen === -1 ? buffered : buffered.slice(seen + 1);
  held.buffer = undefined;

  held.connection.caughtUp();
  for (const entry of live) deliver(held.connection, entry);
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
 * Channels it knows nothing about. A Connection that is still opening buffers it whole,
 * Channel and kind alike: the cut that ends its replay searches that buffer by Cursor.
 */
function route(state: InstanceState, entry: StoredEntry): void {
  for (const held of state.held.values()) {
    if (held.buffer === undefined) deliver(held.connection, entry);
    else held.buffer.push(entry);
  }
}

/** One Entry to one live Connection: a Message on a Channel it named, and nothing else. */
function deliver(connection: Connection, entry: StoredEntry): void {
  if (entry.type !== "message") return;
  if (connection.channels.has(entry.channel)) connection.deliver(entry);
}
