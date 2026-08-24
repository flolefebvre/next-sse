import { transportOptionsFromEnv } from "../internal/env.js";
import { createMemoryTransport } from "../transport/memory.js";
import type {
  Cursor,
  Entry,
  Page,
  StoredEntry,
  Transport,
  Unsubscribe,
} from "../transport/index.js";

/**
 * How the Redis Transport is loaded. It is the module's own type, so the factory's signature
 * cannot drift from what this file expects; `typeof import(...)` is types only and loads
 * nothing at runtime.
 */
type LoadRedis = () => Promise<typeof import("../transport/redis.js")>;

const loadRedis: LoadRedis = () => import("../transport/redis.js");

/**
 * The Transport an App gets when it configures none (ADR-0008): `REDIS_URL` set means the Redis
 * Transport, unset means the Memory one. The whole ADR-0006 table is parsed before `REDIS_URL`
 * is read, so a bad value is reported on a host that configures no server too.
 *
 * The Redis Transport is loaded lazily, and `initSSE` is synchronous, so what comes back on
 * that branch is a Transport that resolves the real one on its first use. Every method of the
 * interface is asynchronous already and the Instance only ever touches the Transport from an
 * asynchronous path, so nothing above notices — and an App on the Memory path never loads
 * node-redis at all, which is the whole point of the subpath split.
 */
export function selectTransport(
  options: { env?: NodeJS.ProcessEnv; load?: LoadRedis } = {},
): Transport {
  const environment = transportOptionsFromEnv(options.env ?? process.env);
  const load = options.load ?? loadRedis;

  if (environment.url === undefined) {
    return createMemoryTransport({ retention: environment.retention ?? {} });
  }

  const url = environment.url;

  return deferredTransport(async () => {
    const { createRedisTransport } = await load();

    return createRedisTransport({ ...environment, url });
  });
}

/**
 * A Transport whose own is opened on first use: what lets a synchronous `initSSE` hold a
 * Transport that lives behind a dynamic import.
 *
 * The open runs once, whichever method asked for it first, and every later call waits on that
 * same promise. Closing one that was never used opens nothing: a process that built an Instance
 * and shut down without a Connection loads no backend client on the way out.
 */
function deferredTransport(open: () => Promise<Transport>): Transport {
  let opening: Promise<Transport> | undefined;

  const opened = (): Promise<Transport> => (opening ??= open());

  return {
    async publish(entry: Entry): Promise<Cursor> {
      return (await opened()).publish(entry);
    },
    async read(after: Cursor | undefined, limit: number): Promise<Page> {
      return (await opened()).read(after, limit);
    },
    async tail(): Promise<Cursor> {
      return (await opened()).tail();
    },
    async subscribe(
      listener: (entry: StoredEntry) => void,
      options: { onGap: () => void },
    ): Promise<Unsubscribe> {
      return (await opened()).subscribe(listener, options);
    },
    async close(): Promise<void> {
      if (opening === undefined) return;

      await (await opened()).close();
    },
  };
}
