import { withDeadline } from "../internal/deadline.js";
import { transportOptionsFromEnv } from "../internal/env.js";

import {
  TransportClosedError,
  TransportError,
  TransportUnavailableError,
  type Cursor,
  type Entry,
  type Page,
  type Publisher,
  type Retention,
  type StoredEntry,
  type Transport,
  type Unsubscribe,
} from "./index.js";
import {
  createRedisLink,
  type RedisClientLike,
  type RedisErrorHook,
  type RedisOperation,
  type RedisReader,
} from "./redis-client.js";
import {
  BEFORE_ANYTHING,
  compareIds,
  DEFAULT_PREFIX,
  ENTRY_FIELD,
  isStreamId,
  logKeyOf,
  parseEntry,
  readRange,
  readStreamInfo,
  readStreams,
  type RawEntry,
  type StreamInfo,
} from "./redis-reply.js";

/** How long an Entry stays readable, in seconds, unless the App says otherwise (ADR-0006). */
const DEFAULT_WINDOW_SECONDS = 300;

/** How many Entries the log keeps at most, unless the App says otherwise (ADR-0006). */
const DEFAULT_CAP = 10_000;

/** How long one operation may take before it is reported as unavailable, in milliseconds. */
const DEFAULT_OPERATION_TIMEOUT = 1_000;

/** How long one `XREAD` blocks: long enough to be one round trip, short enough to be alive. */
const BLOCK_MS = 5_000;

/** How many Entries one `XREAD` may bring back at once. */
const READ_COUNT = 1_000;

/** The longest the reader waits between two window trims (ADR-0006). */
const TRIM_CEILING_MS = 60_000;

/** How long the reader waits after a failed `XREAD` before reissuing it. */
const REISSUE_PAUSE_MS = 250;

export interface RedisTransportOptions {
  /** The server to connect to. Defaults to `REDIS_URL`. */
  url?: string;
  /**
   * A node-redis client to use instead of one of this Transport's own — standalone, Cluster or
   * Sentinel, recognised structurally. The caller keeps ownership: it is never closed here, and
   * the reader runs on a `duplicate()` of it.
   */
  client?: RedisClientLike;
  /**
   * The per-App namespace every key sits under, inside the hash tag. Defaults to
   * `NEXT_SSE_PREFIX`, and to `next-sse` when that is unset — so two Apps sharing one server
   * under the default Prefix deliver each other's Messages, which is why an App that shares a
   * server sets its own.
   */
  prefix?: string;
  /** How much of the log is kept. Defaults to `NEXT_SSE_RETENTION_WINDOW` and `_CAP`. */
  retention?: Retention;
  /** How long one operation may take, in milliseconds. Defaults to `NEXT_SSE_OPERATION_TIMEOUT`. */
  operationTimeout?: number;
  /** Every failure this Transport meets, named by the operation it happened in. */
  onError?: RedisErrorHook;
  /** Narrate what the reader is doing. Defaults to `NEXT_SSE_DEBUG`. */
  debug?: boolean;
}

/**
 * The multi-Instance Transport: one Redis Stream per App at `{<Prefix>}:log`, on Redis or
 * Valkey (ADR-0006).
 *
 * `publish` is one `XADD` with the count cap on it, the Cursor it answers is the stream entry
 * ID, `read` is `XRANGE` strictly after that ID, `tail` is `XINFO STREAM`, and the live feed is
 * one `XREAD BLOCK` loop per Instance on a connection of its own. No Pub/Sub, no Lua, nothing
 * past Redis 6.2/7.0: Valkey 8 is a first-class target.
 *
 * Configuration is the ADR-0006 environment table with this object on top: what is passed here
 * wins over what the environment says, field by field.
 */
export function createRedisTransport(options: RedisTransportOptions = {}): Transport {
  return createRedisLog(options);
}

/**
 * The publisher-only half of the Redis Transport (ADR-0005), for a process outside Next.js:
 * the very same log, with no live feed and no replay.
 *
 * It is the same object narrowed, not a second implementation: the reader connection and the
 * window trimming are brought up by the first `subscribe`, which a Publisher never calls, so a
 * worker that only Publishes holds exactly one connection.
 */
export function createRedisPublisher(options: RedisTransportOptions = {}): Publisher {
  const log = createRedisLog(options);

  return {
    publish: (entry) => log.publish(entry),
    tail: () => log.tail(),
    close: () => log.close(),
  };
}

/** One listener on the live feed, with the gap report that belongs to it. */
interface Feed {
  listener: (entry: StoredEntry) => void;
  onGap: () => void;
}

function createRedisLog(options: RedisTransportOptions): Transport {
  const environment = transportOptionsFromEnv();
  const url = options.url ?? environment.url;
  const prefix = options.prefix ?? environment.prefix ?? DEFAULT_PREFIX;
  const windowSeconds =
    options.retention?.window ?? environment.retention?.window ?? DEFAULT_WINDOW_SECONDS;
  const cap = options.retention?.cap ?? environment.retention?.cap ?? DEFAULT_CAP;
  const operationTimeout =
    options.operationTimeout ?? environment.operationTimeout ?? DEFAULT_OPERATION_TIMEOUT;
  const debug = options.debug ?? environment.debug ?? false;
  const onError: RedisErrorHook = options.onError ?? ((): void => undefined);

  if (url === undefined && options.client === undefined) {
    throw new TransportError(
      "The Redis Transport needs a server: pass `url` or `client`, or set `REDIS_URL`.",
    );
  }

  const key = logKeyOf(prefix);
  const link = createRedisLink({ url, client: options.client, key, onError });

  /**
   * How often the window is trimmed: once a minute, or twice per window when the window is
   * shorter than that (ADR-0006). The effective window is the window plus up to one interval,
   * which a window of its own scale keeps sensible.
   */
  const trimIntervalMs = Math.min(TRIM_CEILING_MS, Math.max((windowSeconds * 1000) / 2, 1));

  const feeds = new Set<Feed>();
  let closed = false;
  let feeding: Promise<void> | undefined;
  let reader: RedisReader | undefined;
  let trimTimer: NodeJS.Timeout | undefined;

  const narrate = (message: string): void => {
    if (debug) console.debug(`[next-sse] ${message}`);
  };

  const assertOpen = (): void => {
    if (closed) throw new TransportClosedError("This Redis Transport has been closed.");
  };

  /** One operation, bounded and reported: nothing is retried, and every failure is named. */
  const bounded = async <T>(operation: RedisOperation, run: () => Promise<T>): Promise<T> => {
    assertOpen();

    try {
      return await withDeadline(operationTimeout, run);
    } catch (error) {
      onError(error, operation);

      throw asTransportError(error);
    }
  };

  /**
   * What `XINFO STREAM` says about the log, on a stream that may not exist yet: a key nothing
   * was ever published to is a log at the position before its first Entry, not a failure.
   */
  const streamInfo = async (send: (args: string[]) => Promise<unknown>): Promise<StreamInfo> => {
    try {
      return readStreamInfo(await send(["XINFO", "STREAM", key]));
    } catch (error) {
      if (!isMissingKey(error)) throw error;

      return {
        lastGeneratedId: BEFORE_ANYTHING,
        oldestKeptId: BEFORE_ANYTHING,
        everDropped: false,
      };
    }
  };

  /**
   * The Entries of a raw page, with their Cursors on them. An Entry this library cannot read —
   * an unparseable envelope, an unknown version or kind — is skipped and reported: the read
   * path validates nothing else, and an external publisher's mistake must not stop the log
   * (ADR-0006).
   */
  const entriesOf = (raw: RawEntry[], operation: RedisOperation): StoredEntry[] => {
    const entries: StoredEntry[] = [];

    for (const item of raw) {
      const entry = parseEntry(item.fields);
      if (entry === undefined) {
        onError(
          new TransportError(`The Entry at ${item.id} is not one this library can read.`),
          operation,
        );
        continue;
      }

      entries.push({ ...entry, cursor: item.id });
    }

    return entries;
  };

  /**
   * Trim what the window no longer covers, against the server's own clock: `MINID ~` on the
   * reader's period. Concurrent trims from several Instances are harmless, and a trim that
   * fails is reported and waited out — the count cap on every `XADD` is what must hold.
   */
  const trimWindow = async (): Promise<void> => {
    try {
      const time = readRangeTime(await link.send(["TIME"]));
      const oldest = Math.max(time - windowSeconds * 1000, 0);
      await link.send(["XTRIM", key, "MINID", "~", `${String(oldest)}-0`]);
      narrate(`trimmed the log to what has been published since ${String(oldest)}`);
    } catch (error) {
      if (closed) return;
      onError(error, "trim");
    }
  };

  /**
   * The blocking reader: one `XREAD BLOCK` at a time, from the last position it saw, for as
   * long as this Transport is open. It survives the client's own reconnect by reissuing from
   * that position, which is what makes an Instance's Redis reconnect cost nothing.
   *
   * The gap is checked where a gap can appear: on the position the loop *resumes* from — before
   * the first read, and after any read that failed — never per batch. Between two successful
   * reads there is nothing to check: the loop holds the position the server last handed it, and
   * an `XINFO` per batch would be a round trip on the hot path for it (ADR-0006).
   */
  const feed = async (from: Cursor): Promise<void> => {
    let position = from;
    /**
     * The loop starts at the tail this Transport read itself, so there is nothing to check
     * before the first block: no Cursor of a caller's is in play, and a position the log has
     * just handed out cannot be one it has already dropped. The check belongs to the resume
     * path, where the connection was lost and the log went on without the reader.
     */
    let resuming = false;

    while (!closed) {
      try {
        const connection = reader;
        if (connection === undefined) return;

        if (resuming) {
          position = await resumeFrom(connection, position);
          resuming = false;
        }

        const reply = await connection.send([
          "XREAD",
          "COUNT",
          String(READ_COUNT),
          "BLOCK",
          String(BLOCK_MS),
          "STREAMS",
          key,
          position,
        ]);

        const raw = readStreams(reply, "XREAD");
        for (const entry of entriesOf(raw, "subscribe")) {
          for (const { listener } of feeds) listener(entry);
        }

        /**
         * The position advances over what the log handed back, Entries this library could not
         * read included: they are skipped, not read again on the next block.
         */
        const last = raw[raw.length - 1];
        if (last !== undefined) position = last.id;
      } catch (error) {
        if (closed) return;

        onError(error, "subscribe");
        narrate(`the reader lost its connection and will resume from ${position}`);
        resuming = true;
        await pause(REISSUE_PAUSE_MS);
      }
    }
  };

  /**
   * Where the loop resumes: the position it holds, unless the log has since dropped it — in
   * which case the gap is reported once and the loop resumes at the boundary, so that the very
   * same gap can never be reported twice.
   */
  const resumeFrom = async (connection: RedisReader, position: Cursor): Promise<Cursor> => {
    const info = await streamInfo((args) => connection.send(args));
    if (!lost(info, position)) return position;

    narrate(`the log dropped ${position}, which the reader was resuming from`);
    for (const { onGap } of feeds) onGap();

    /**
     * The loop resumes just below the oldest Entry the log still holds, so that Entry is
     * delivered and the same gap can never be reported twice.
     */
    return justBefore(info.oldestKeptId);
  };

  return {
    async publish(entry: Entry): Promise<Cursor> {
      const reply = await bounded("publish", () =>
        link.send([
          "XADD",
          key,
          "MAXLEN",
          "~",
          String(cap),
          "*",
          ENTRY_FIELD,
          JSON.stringify(entry),
        ]),
      );

      return String(reply);
    },

    async read(after: Cursor | undefined, limit: number): Promise<Page> {
      assertOpen();

      /**
       * A Cursor no stream could have minted — one from another Transport, or no Cursor format
       * at all — is `gone`, never a rejection: the Instance answers `reset` rather than an error
       * for a Cursor it has no way to inspect (ADR-0005).
       */
      if (after !== undefined && !isStreamId(after)) return { gone: true };

      const count = Math.max(limit, 0);
      const { raw, info } = await bounded("read", async () => {
        /**
         * The range is asked for first and the boundary read after it, in that order on the
         * wire: a trim that lands between them then shows up in the boundary, and the page is
         * answered `gone` rather than served with a hole in it.
         */
        const range = link.send([
          "XRANGE",
          key,
          after === undefined ? "-" : `(${after}`,
          "+",
          "COUNT",
          String(count),
        ]);
        const boundary = streamInfo((args) => link.send(args));
        const [rangeReply, info] = await Promise.all([range, boundary]);

        return { raw: readRange(rangeReply, "XRANGE"), info };
      });

      /**
       * Everything strictly after this Cursor is still in the log exactly when the Cursor is at
       * or above the oldest Entry the log holds: a log only ever drops from its front. It is
       * conservative by one Cursor — the newest dropped Entry answers `gone` although nothing
       * after it was lost — and never the other way round, which is the direction gap-free
       * delivery depends on (ADR-0006, corrected).
       */
      if (after !== undefined && lost(info, after)) return { gone: true };

      /**
       * Caught up means there is nothing left after what came back, which a full page can be
       * too: the boundary read alongside the range already says what the log's last position
       * is, so the answer is exact rather than one page late.
       */
      const last = raw[raw.length - 1];
      const done = raw.length < count || last?.id === info.lastGeneratedId;

      return { entries: entriesOf(raw, "read"), done };
    },

    async tail(): Promise<Cursor> {
      const info = await bounded("tail", () => streamInfo((args) => link.send(args)));

      return info.lastGeneratedId;
    },

    async subscribe(
      listener: (entry: StoredEntry) => void,
      options: { onGap: () => void },
    ): Promise<Unsubscribe> {
      assertOpen();

      const attached: Feed = { listener, onGap: options.onGap };
      feeds.add(attached);

      try {
        /**
         * The subscription resolves only once every later Publish is guaranteed to be delivered
         * (ADR-0005): the position the loop starts from is the log's tail, taken here, so
         * nothing published after this point can be below it.
         */
        feeding ??= (async () => {
          const info = await bounded("subscribe", () => streamInfo((args) => link.send(args)));
          reader = await link.reader();
          narrate(`the reader is following the log from ${info.lastGeneratedId}`);
          trimTimer ??= setInterval(() => void trimWindow(), trimIntervalMs).unref();

          void feed(info.lastGeneratedId);
        })();

        await feeding;
      } catch (error) {
        feeds.delete(attached);
        feeding = undefined;

        throw error;
      }

      return () => {
        feeds.delete(attached);
      };
    },

    async close(): Promise<void> {
      closed = true;
      feeds.clear();
      if (trimTimer !== undefined) clearInterval(trimTimer);
      trimTimer = undefined;

      const connection = reader;
      reader = undefined;
      if (connection !== undefined) await connection.close().catch(() => undefined);
      await link.close().catch(() => undefined);
    },
  };
}

/**
 * Whether the log has lost anything that came after this position: it has dropped Entries at
 * all, and this position is below the oldest it still serves.
 *
 * It is conservative by one Cursor — the newest dropped Entry answers `gone` although nothing
 * after it was lost — and never the other way round, which is the direction gap-free delivery
 * depends on (ADR-0006, corrected).
 */
function lost(info: StreamInfo, position: Cursor): boolean {
  return info.everDropped && compareIds(position, info.oldestKeptId) < 0;
}

/** The position immediately below one: what a reader resumes from to be handed that Entry. */
function justBefore(id: string): string {
  const [ms, seq] = id.split("-");
  const milliseconds = Number(ms);
  const sequence = Number(seq);

  if (sequence > 0) return `${String(milliseconds)}-${String(sequence - 1)}`;
  if (milliseconds === 0) return BEFORE_ANYTHING;

  return `${String(milliseconds - 1)}-${HIGHEST_SEQUENCE}`;
}

/** The highest sequence number one millisecond can hold: an unsigned 64-bit integer. */
const HIGHEST_SEQUENCE = "18446744073709551615";

/** The `TIME` reply, in milliseconds: seconds first, microseconds second. */
function readRangeTime(reply: unknown): number {
  if (!Array.isArray(reply) || reply.length < 2) {
    throw new TransportError("`TIME` answered a reply this Transport cannot read.");
  }

  return Number(reply[0]) * 1000 + Math.floor(Number(reply[1]) / 1000);
}

/** Whether a failure is the server saying the stream does not exist. */
function isMissingKey(error: unknown): boolean {
  return error instanceof Error && /no such key/i.test(error.message);
}

/** What one failure of the backend is reported as, in the taxonomy of ADR-0005. */
function asTransportError(error: unknown): TransportError {
  if (error instanceof TransportError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";

  return UNREACHABLE_NAMES.has(name) || UNREACHABLE_MESSAGE.test(message)
    ? new TransportUnavailableError(message)
    : new TransportError(message);
}

/**
 * What node-redis calls a failure that means the backend is not there: the deadline this
 * Transport takes itself, the client refusing a command while it is down, and the socket going
 * away under one. Anything else — a command the server refused, a reply nothing can read — is a
 * plain `TransportError`.
 */
const UNREACHABLE_NAMES = new Set([
  "DeadlineError",
  "ClientOfflineError",
  "ClientClosedError",
  "SocketClosedUnexpectedlyError",
  "ConnectionTimeoutError",
  "SocketTimeoutError",
  "DisconnectsClientError",
  "ReconnectStrategyError",
  "RootNodesUnavailableError",
]);

const UNREACHABLE_MESSAGE =
  /not connected|is closed|is offline|socket|connect|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND/i;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
