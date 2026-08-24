import type { ChannelRecord } from "../internal/channel.js";
import type { Cursor, StoredEntry, Transport, Unsubscribe } from "../transport/index.js";

import { selectTransport } from "./select-transport.js";

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

/** How often a Connection is heartbeated when the App configures nothing (ADR-0004). */
const DEFAULT_HEARTBEAT_MS = 15_000;

/** How long a Connection lives when the App configures nothing (ADR-0004). */
const DEFAULT_MAX_LIFETIME_MS = 30 * 60_000;

/** One open SSE Connection, as the Instance sees it: what it listens to, and how to feed it. */
export interface Connection {
  /** The Channels this Connection subscribed to: the ones Authorize let through. */
  readonly channels: ReadonlySet<string>;
  /**
   * The opaque identity this App gave the Connection, when it configured a `key` (ADR-0003).
   * Nothing reads it yet: it is what a Kick will address Connections by, and the Connection
   * table is where it has to be for that to be possible at all.
   */
  readonly key?: string;
  /** Hand it one Message it is subscribed to. Must not throw. */
  deliver(entry: StoredMessage): void;
  /** Its Cursor is unusable: the App must refetch its state before going on. Must not throw. */
  reset(): void;
  /** The replay is over and everything from here on is live. Must not throw. */
  caughtUp(): void;
  /**
   * End this Connection with the `reconnect` Control event: the client core comes back at once,
   * with its Cursor, so the cut costs a round trip and never a Message (ADR-0004).
   *
   * It is the **one** way a Connection is ended from the server side, and the reason it lives on
   * the Connection rather than in the handler's own scope: the max lifetime reaches it from
   * there, and Kick (ADR-0003) and Drain (ADR-0011) reach it from here, over the Connection
   * table, needing nothing of a Connection but this. Ending one twice is a no-op, and so is
   * ending one whose client has already gone. Must not throw.
   */
  reconnect(): void;
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

/**
 * How an App builds the context its Authorize and its Key are handed, as the Instance holds it:
 * the Ctx is the App's own, and the library only ever awaits what it produces (ADR-0008).
 */
export type ContextBuilder = (request: Request) => unknown;

/**
 * How an App derives the Key of a Connection from that context. `never` is the Ctx here for the
 * same reason it is on a declared Authorize: the Instance holds the function without knowing
 * what the App builds, and the handler makes the one cast where it does.
 */
export type KeyBuilder = (ctx: never) => string | undefined;

/** Everything one running Instance of an App owns. */
export interface Instance {
  /** The one log this Instance reads and Publishes into. */
  readonly transport: Transport;
  /** What this App builds from the request for its Authorize and its Key, if it builds one. */
  context: ContextBuilder | undefined;
  /** How this App names the holder of a Connection, if it names one (ADR-0003). */
  key: KeyBuilder | undefined;
  /**
   * How often every Connection of this Instance is heartbeated, in milliseconds, and how long
   * one is allowed to live before it is ended with `reconnect`. Both are resolved here — the
   * App's value or the default, `0` meaning off — so that the handler arms its timers from a
   * number rather than from a policy of its own.
   */
  heartbeat: number;
  maxLifetime: number;
  /** The Connections this Instance is holding open right now. */
  readonly connections: ReadonlySet<Connection>;
  /**
   * The App's current Registry, as data: a re-evaluated `createSSE` swaps it. It is what the
   * handler resolves the Channel names on a Connection's query against, and so where Authorize
   * is read from.
   */
  registry: ChannelRecord | undefined;
  /**
   * Register a Connection and start feeding it, resuming after `after` when it brought a
   * Cursor. Registering comes first, before the log is read at all: the live feed is buffered
   * from that moment, which is what makes the replay→live cut exact (ADR-0005).
   */
  open(connection: Connection, options?: { after?: Cursor }): Promise<Opening>;
}

/**
 * One Connection as the Instance holds it: itself, the live Entries buffered while it is still
 * opening, and the Cursors its replay already carried. A buffer of `undefined` is a Connection
 * that has caught up and is live; `replayed` of `undefined` is one the live feed has carried
 * past everything it was replayed.
 */
interface Held {
  connection: Connection;
  buffer: StoredEntry[] | undefined;
  replayed: Set<Cursor> | undefined;
  /**
   * The live feed lost its place while this Connection was still opening, so it is owed a
   * `reset` it cannot be given yet: nothing may reach a Connection before the `ready` the
   * handler has not written, and its replay is still walking a log that moved under it. It is
   * delivered where a `reset` belongs, just before `caught-up`.
   */
  gap: boolean;
}

interface InstanceState extends Instance {
  held: Map<Connection, Held>;
  feed: Promise<Unsubscribe> | undefined;
}

const globals = globalThis as unknown as { [key: symbol]: InstanceState | undefined };

/** Everything an App configures on `initSSE`, as the Instance takes it (ADR-0008). */
export interface InstanceOptions {
  transport?: Transport;
  context?: ContextBuilder;
  key?: KeyBuilder;
  heartbeat?: number;
  maxLifetime?: number;
}

/**
 * The Instance of this process, created on first use.
 *
 * Two rules, and they are opposites on purpose. A `transport` given on a later call is
 * deliberately **ignored**: the whole point of the slot is that a second evaluation of the App's
 * Registry module — which builds a second Transport as it goes — keeps Publishing into the log
 * the open Connections are reading. An App that configures none gets the Transport `REDIS_URL`
 * chooses (ADR-0008). But `context` and `key` are **refreshed** on every call, exactly as
 * `createSSE` swaps the Registry (ADR-0004): they are App code holding no live state, and
 * pinning them to the first evaluation would leave an edit to `context` with no effect until
 * the process restarts, while the Authorize beside it — which lives in the Registry — did
 * change. `heartbeat` and `maxLifetime` are refreshed for the same reason; the Connections
 * already open keep the timers they were armed with, and the next ones get the new values.
 */
export function getInstance(options: InstanceOptions = {}): Instance {
  const heartbeat = milliseconds(options.heartbeat, DEFAULT_HEARTBEAT_MS, "heartbeat");
  const maxLifetime = milliseconds(options.maxLifetime, DEFAULT_MAX_LIFETIME_MS, "maxLifetime");
  const existing = globals[SLOT];
  if (existing) {
    existing.context = options.context;
    existing.key = options.key;
    existing.heartbeat = heartbeat;
    existing.maxLifetime = maxLifetime;

    return existing;
  }

  const state: InstanceState = {
    transport: options.transport ?? selectTransport(),
    context: options.context,
    key: options.key,
    heartbeat,
    maxLifetime,
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

  const held: Held = { connection, buffer: [], replayed: undefined, gap: false };
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
 * them: replay pages strictly after the Cursor, then `caught-up`, then the live Entries that
 * were buffered while the replay ran — minus the ones the replay already carried.
 *
 * The Instance never orders two Cursors. What the replay carried is remembered as a set, and
 * the feed skips an Entry that is in it until it meets one that is not, which is the moment the
 * two have joined up: the feed is ordered, so nothing that was replayed can arrive after
 * something that was not. Doing it this way rather than cutting the buffer at the last replayed
 * Cursor is what makes the seam hold for a Transport whose reader runs behind its `read` — a
 * Redis subscription lagging by one Entry would otherwise deliver that Entry twice.
 *
 * A live-only Connection replays nothing, so its set is empty and it is fed whatever landed in
 * its buffer while it was opening, including Entries the tail it adopted already covers. That
 * is over-delivery, not duplication: this client has seen nothing yet, its position follows
 * what it actually receives, and withholding those Entries would take ordering the Instance
 * does not have — under a lagging reader it could not be done reliably at all.
 */
async function replay(
  state: InstanceState,
  held: Held,
  cursor: Cursor,
  first: Awaited<ReturnType<Transport["read"]>> | undefined,
  gone: boolean,
): Promise<void> {
  if (gone) held.connection.reset();

  const replayed = new Set<Cursor>();
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
      replayed.add(entry.cursor);
      if (entry.type === "message" && held.connection.channels.has(entry.channel)) {
        held.connection.deliver(entry);
      }
    }

    /**
     * A client that went away mid-replay is owed nothing further: the Connection has left the
     * table, and paging the rest of the log for it would be work nobody is reading.
     */
    if (!state.held.has(held.connection)) return;

    page = page.done ? undefined : await state.transport.read(last, REPLAY_PAGE_SIZE);
  }

  const buffered = held.buffer ?? [];
  held.buffer = undefined;
  held.replayed = replayed;

  if (held.gap) {
    held.gap = false;
    held.connection.reset();
  }
  held.connection.caughtUp();
  for (const entry of buffered) feed(held, entry);
}

/**
 * The one subscription this Instance holds, started with the first Connection: every Instance
 * reads the whole log once and routes what it reads itself (ADR-0005), rather than asking the
 * Transport for anything Channel-shaped.
 *
 * A subscription that could not be opened is **not** remembered. The Transport rejects while
 * the backend is away (ADR-0006), and a rejected promise left in the slot would answer every
 * later connect with the failure of the first one — the outage would outlive itself for the
 * length of the process.
 */
async function ensureFeed(state: InstanceState): Promise<void> {
  const feed = (state.feed ??= state.transport.subscribe(
    (entry) => {
      route(state, entry);
    },
    {
      onGap: () => {
        gap(state);
      },
    },
  ));

  try {
    await feed;
  } catch (error) {
    if (state.feed === feed) state.feed = undefined;
    throw error;
  }
}

/**
 * The live feed came back somewhere the log no longer serves: everything this Instance holds is
 * behind a gap it cannot describe, so every Connection is told to refetch and carries on live
 * (ADR-0004). Nothing is closed — a Transport outage is not the client's failure, and closing
 * would turn a backend blip into a herd against Instances that were equally cut off.
 *
 * The Transport reports it once per resume, and only when the position it resumed from is below
 * what the log still serves; an outage that lost nothing costs the Connections nothing.
 */
function gap(state: InstanceState): void {
  for (const held of state.held.values()) {
    if (held.buffer === undefined) held.connection.reset();
    else held.gap = true;
  }
}

/**
 * One Entry, to the Connections that asked for its Channel. An Entry no Connection here
 * subscribes to is dropped for free — during a rolling deploy an Instance legitimately reads
 * Channels it knows nothing about. A Connection that is still opening buffers it whole,
 * Channel and kind alike: the cut that ends its replay searches that buffer by Cursor.
 */
function route(state: InstanceState, entry: StoredEntry): void {
  for (const held of state.held.values()) {
    if (held.buffer === undefined) feed(held, entry);
    else held.buffer.push(entry);
  }
}

/**
 * One Entry to a Connection past its replay, unless the replay already carried it. The first
 * Entry the replay did not carry is where the two joined up, and nothing is checked afterwards.
 */
function feed(held: Held, entry: StoredEntry): void {
  if (held.replayed !== undefined) {
    if (held.replayed.has(entry.cursor)) return;
    held.replayed = undefined;
  }

  deliver(held.connection, entry);
}

/** One Entry to one live Connection: a Message on a Channel it named, and nothing else. */
function deliver(connection: Connection, entry: StoredEntry): void {
  if (entry.type !== "message") return;
  if (connection.channels.has(entry.channel)) connection.deliver(entry);
}

/**
 * The longest delay a timer takes. Past it, `setTimeout` and `setInterval` overflow their 32-bit
 * delay and fire almost at once — a 30-day `maxLifetime` would be every Connection ending on the
 * spot, forever — so the value is refused rather than quietly turned into its opposite.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * One duration off the App's configuration: the value it gave, or the default when it gave
 * none. `0` is a value like any other and means the feature is off — never "use the default",
 * which is what makes `heartbeat: 0` a Connection with no heartbeat rather than one with the
 * standard fifteen seconds.
 *
 * Anything that is not a duration is refused here rather than handed to `setTimeout`, where a
 * negative number fires at once and `NaN` fires at once too: a mistyped option would otherwise
 * become a Connection ended the instant it opened.
 */
function milliseconds(value: number | undefined, fallback: number, option: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_MS) {
    throw new Error(
      `next-sse: initSSE({ ${option} }) takes a number of milliseconds between 0 and ` +
        `${String(MAX_TIMER_MS)} (about 24 days), and was given ${String(value)}. Pass 0 to ` +
        `turn it off.`,
    );
  }

  return value;
}
