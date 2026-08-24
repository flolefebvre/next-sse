import { createClient } from "redis";

/** How long the TCP connect itself may take. */
const CONNECT_TIMEOUT = 2_000;

/**
 * How long the socket may stay idle before it is torn down. It is what bounds a handshake
 * nothing answers — a proxy in front of a dead server accepts the connection and never replies
 * to `HELLO`, which `connectTimeout` goes through without noticing. It also has to sit above
 * the reader's `XREAD BLOCK`, which is idle by design for as long as the log is quiet.
 */
const SOCKET_TIMEOUT = 15_000;

/** One `PING` on this period keeps a healthy but quiet connection from timing out. */
const PING_INTERVAL = 10_000;

/**
 * The longest this Transport waits between two reconnection attempts. It is well under the
 * operation timeout on purpose: every operation is deadline-bounded, so a backend that came
 * back has to be reconnected to inside one operation's own bound, or a healed backend would go
 * on failing operations for as long as the backoff lasted.
 */
const RECONNECT_CAP = 250;
const RECONNECT_JITTER = 100;

/**
 * How long to wait before the next reconnection attempt: 50·2ⁿ ms, capped, plus a little jitter
 * so that every Instance of a deployment does not come back on the same millisecond.
 *
 * It is a delay for every attempt count, however large, and never `false` nor an `Error`:
 * node-redis reads either of those as "give up", which closes the client for good and turns an
 * outage into a Transport that never works again.
 */
export function reconnectDelay(retries: number): number {
  return Math.min(50 * 2 ** retries, RECONNECT_CAP) + Math.random() * RECONNECT_JITTER;
}

/** What the Transport reports a failure of the connection itself under. */
export type RedisOperation = "connect" | "publish" | "read" | "tail" | "subscribe" | "trim";

/** One failure of the backend, as the App hears about it. */
export type RedisErrorHook = (error: unknown, operation: RedisOperation) => void;

/** Which of the three node-redis clients an injected client is. */
export type RedisClientKind = "standalone" | "cluster" | "sentinel";

/**
 * What this Transport listens to on its client: the failure node-redis emits outside any
 * operation, which the process crashes without a listener for.
 */
interface Emitter {
  on(event: "error" | "ready", listener: (...payload: unknown[]) => void): unknown;
  off(event: "error" | "ready", listener: (...payload: unknown[]) => void): unknown;
}

/**
 * The client the Transport holds, seen as narrowly as it uses it, so that a client the caller
 * injected satisfies it whatever its generic parameters: a client built with custom scripts, or
 * with `RESP: 2`, is not assignable to `RedisClientType` at all, and this library has no reason
 * to know about either.
 *
 * Every command goes through `sendCommand`, whose arguments are the one thing the three kinds
 * differ in: a standalone client takes the command, a Sentinel client takes the read/write
 * intent first — the Transport always asks for the master — and a Cluster client takes the key
 * that routes it, which for this Transport is always the one log key.
 */
export interface StandaloneClientLike extends Emitter {
  sendCommand(args: string[]): Promise<unknown>;
  duplicate(overrides?: Record<string, unknown>): DuplicateOf<StandaloneClientLike>;
}

export interface SentinelClientLike extends Emitter {
  sendCommand(isReadonly: boolean, args: string[]): Promise<unknown>;
  duplicate(overrides?: Record<string, unknown>): DuplicateOf<SentinelClientLike>;
}

export interface ClusterClientLike extends Emitter {
  sendCommand(firstKey: string, isReadonly: boolean, args: string[]): Promise<unknown>;
  duplicate(overrides?: Record<string, unknown>): DuplicateOf<ClusterClientLike>;
}

/** A connection of this Transport's own: one it connects, and one it closes. */
type DuplicateOf<Client> = Client & Connectable;

/**
 * What this Transport needs of a connection it owns and must bring up itself. `unref` is
 * optional because only a standalone client has one; a Cluster or Sentinel client holds its
 * sockets out of reach and keeps no process open of its own.
 */
interface Connectable {
  connect(): Promise<unknown>;
  close(): Promise<unknown>;
  destroy(): unknown;
  isReady: boolean;
  unref?: () => void;
  on(event: "error" | "ready", listener: (...payload: unknown[]) => void): unknown;
}

/** A node-redis client of any of the three kinds, as this Transport uses it. */
export type RedisClientLike = StandaloneClientLike | SentinelClientLike | ClusterClientLike;

/** A connection duplicated from one of them, which this Transport connects and closes itself. */
type RedisDuplicate =
  | DuplicateOf<StandaloneClientLike>
  | DuplicateOf<SentinelClientLike>
  | DuplicateOf<ClusterClientLike>;

/**
 * Which kind a client is: the one structural check of this library, whose answer decides how a
 * command is handed to `sendCommand`.
 *
 * It is structural rather than an `instanceof`, because a caller's client may come from another
 * copy of node-redis, and it reads members node-redis documents — `nodeClient`, the way a
 * Cluster client hands out the client of one node, and `use`, the way a Sentinel client leases
 * one — rather than an arity nobody maintains or a private field a rename would move under us.
 * A standalone client has neither.
 */
export function clientKind(client: object): RedisClientKind {
  if ("nodeClient" in client) return "cluster";
  if ("use" in client) return "sentinel";

  return "standalone";
}

/** What a Transport needs of its connection to the backend, over all three client kinds. */
export interface RedisLink {
  /** Send one command on the shared connection, connecting it if this is the first. */
  send(args: string[]): Promise<unknown>;
  /**
   * A connection of this link's own for the blocking reader, connected and ready. Duplicated
   * from the client the link holds, so it carries the same credentials, TLS and topology.
   */
  reader(): Promise<RedisReader>;
  /** Release what this link owns. A client the caller injected is never closed, only let go. */
  close(): Promise<void>;
}

/** The reader's own connection: the blocking loop's, and nothing else's. */
export interface RedisReader {
  send(args: string[]): Promise<unknown>;
  close(): Promise<void>;
}

export interface RedisLinkOptions {
  /** The server to connect to, when the link owns its client. */
  url?: string;
  /** The client to use instead, which the caller owns. */
  client?: RedisClientLike;
  /** The key every command of this Transport touches, which is what routes it on a Cluster. */
  key: string;
  onError: RedisErrorHook;
}

const NOT_CONNECTED = "the Redis Transport is not connected";

/**
 * The connection one Transport runs on: its own client on a URL, or the one the caller
 * injected, behind the same three methods either way.
 */
export function createRedisLink(options: RedisLinkOptions): RedisLink {
  const report = (error: unknown): void => {
    options.onError(error, "connect");
  };

  return options.client === undefined
    ? ownedLink(options.url ?? "", options.key, report)
    : injectedLink(options.client, options.key, report);
}

/**
 * The client every owned link is built on, tuned for a backend that may go away: it never gives
 * up reconnecting, it never queues a command while it is down — a queued command would settle
 * long after the deadline of the operation that sent it — and it keeps a quiet connection alive
 * with one `PING` every ten seconds.
 */
function createTunedClient(url: string) {
  return createClient({
    url,
    disableOfflineQueue: true,
    pingInterval: PING_INTERVAL,
    socket: {
      connectTimeout: CONNECT_TIMEOUT,
      socketTimeout: SOCKET_TIMEOUT,
      reconnectStrategy: reconnectDelay,
    },
  });
}

/**
 * Hand one command to a client of the given kind. The three arities are spelled out in exactly
 * this one place; everything above sends a plain array of arguments.
 */
function sendOn(
  client: RedisClientLike,
  kind: RedisClientKind,
  key: string,
  args: string[],
): Promise<unknown> {
  if (kind === "cluster") return (client as ClusterClientLike).sendCommand(key, false, args);
  if (kind === "sentinel") return (client as SentinelClientLike).sendCommand(false, args);

  return (client as StandaloneClientLike).sendCommand(args);
}

/**
 * The overrides every reader connection is duplicated with: no per-command timeout at all. A
 * blocking `XREAD` is idle for as long as the log is quiet, and a client — or a caller —
 * carrying a command timeout would abort it (ADR-0006). The socket posture is inherited from
 * the client it was duplicated from, whose `socketTimeout` this library sets well above the
 * five seconds one `XREAD BLOCK` may sit for.
 */
const READER_OVERRIDES = { commandOptions: { timeout: undefined } };

/**
 * A connection of our own: connected on first use, and reconnected by node-redis for as long as
 * it lives. Nothing is latched — the moment the client is ready again it is handed over as
 * before, which is how one Transport comes back from an outage without being rebuilt.
 *
 * A caller that finds the client down either waits for it to come back or is handed the failure
 * at once, and which of the two it is depends on who is asking. An operation waits: it is
 * already under the Transport's deadline, so a backend that is really gone still fails it inside
 * a bounded time, while a backend that comes back a moment later is used rather than refused.
 * The reader does not wait: its loop has to learn that the connection was lost, so that it looks
 * for a gap before it resumes, and a `send` that quietly waited would hide that from it.
 */
function connecting(client: Connectable): {
  connected: (options?: { wait?: boolean }) => Promise<void>;
  close: () => Promise<void>;
} {
  let attempt: Promise<void> | undefined;
  let waiting: { promise: Promise<void>; ready: () => void } | undefined;

  client.on("ready", () => {
    waiting?.ready();
    waiting = undefined;
  });

  /** One promise for every caller waiting on the same reconnection, and one listener for all. */
  const untilReady = (): Promise<void> => {
    if (client.isReady) return Promise.resolve();

    waiting ??= deferred();

    return waiting.promise;
  };

  return {
    connected: async ({ wait = true } = {}): Promise<void> => {
      if (client.isReady) return;

      attempt ??= client.connect().then(
        () => {
          client.unref?.();
        },
        (error: unknown) => {
          attempt = undefined;
          throw error;
        },
      );

      await attempt.catch((error: unknown) => {
        if (!wait) throw error;
      });

      if (client.isReady) return;
      if (!wait) throw new Error(NOT_CONNECTED);

      await untilReady();
    },
    close: async (): Promise<void> => {
      const started = attempt;
      if (started === undefined) return;
      attempt = undefined;

      if (client.isReady) await client.close();
      else client.destroy();

      await started.catch(() => undefined);
    },
  };
}

/**
 * One reader connection: a duplicate of the client the link holds, connected here and closed
 * with the subscription that asked for it.
 */
async function openReader(
  duplicate: RedisDuplicate,
  kind: RedisClientKind,
  key: string,
  report: (error: unknown) => void,
): Promise<RedisReader> {
  duplicate.on("error", report);
  const lifecycle = connecting(duplicate);

  return {
    send: async (args) => {
      await lifecycle.connected({ wait: false });

      return sendOn(duplicate, kind, key, args);
    },
    close: async () => {
      await lifecycle.close();
    },
  };
}

/** The link's own client: created here, connected on first use, closed on `close()`. */
function ownedLink(url: string, key: string, report: (error: unknown) => void): RedisLink {
  const client = createTunedClient(url);
  client.on("error", report);
  const lifecycle = connecting(client);

  return {
    send: async (args) => {
      await lifecycle.connected();

      return sendOn(client, "standalone", key, args);
    },
    reader: async () => openReader(client.duplicate(READER_OVERRIDES), "standalone", key, report),
    close: async () => {
      await lifecycle.close();
    },
  };
}

/**
 * A client the caller owns: used exactly as it was handed over, connected or not — a client
 * node-redis has not connected yet queues nothing and fails the operation, which is the same
 * answer an outage gives. The Transport's own `error` listener is the one thing it adds, so
 * that a connection failure is reported like any other, and `close()` takes it back off: one
 * long-lived client feeding several Transports must not collect a listener per Transport.
 */
function injectedLink(
  client: RedisClientLike,
  key: string,
  report: (error: unknown) => void,
): RedisLink {
  const kind = clientKind(client);
  client.on("error", report);

  return {
    send: async (args) => sendOn(client, kind, key, args),
    reader: async () => openReader(client.duplicate(READER_OVERRIDES), kind, key, report),
    close: async () => {
      client.off("error", report);
    },
  };
}

/** One promise with its resolution kept aside, for the callers waiting on a reconnection. */
function deferred(): { promise: Promise<void>; ready: () => void } {
  let ready!: () => void;
  const promise = new Promise<void>((resolve) => {
    ready = resolve;
  });

  return { promise, ready };
}
