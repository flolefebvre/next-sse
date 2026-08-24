# Transport reference

A Transport is a dumb, ordered, bounded log — one per App — that every Instance reads in full. It
knows nothing about Channels, Authorize or Connections: routing, replay and the exactly-once cut
all live in the Instance, written once for every Transport.

`@flefebvre/next-sse/transport` and everything under it import neither Next.js nor React, which is
what lets a worker outside Next.js hold one.

## Choosing one

| `REDIS_URL` | What the App gets       |
| ----------- | ----------------------- |
| unset       | `createMemoryTransport` |
| set         | `createRedisTransport`  |

Zero configuration covers most Apps. Pass `transport` to `initSSE` when you need an injected
client, a Prefix decided in code, custom retention, or an error hook. Explicit configuration wins
over the environment, field by field.

## The Memory Transport

```ts
import { createMemoryTransport } from "@flefebvre/next-sse/transport/memory";

initSSE({ transport: createMemoryTransport({ retention: { window: 600, cap: 50_000 } }) });
```

One in-process log, no backend. It serves **one Instance**: two processes on it share nothing.
Its Cursors carry a per-process epoch, so a Cursor from a previous run is unknown to it and
answers `gone` rather than resuming somewhere arbitrary — which is why a restart on the Memory
Transport is a Reset for every client, and costs no App code
([deployment.md](deployment.md)).

## The Redis / Valkey Transport

```ts
import { createRedisTransport } from "@flefebvre/next-sse/transport/redis";

initSSE({ transport: createRedisTransport({ prefix: "billing-app" }) });
```

One Redis Stream per App at `{<Prefix>}:log`. `publish` is one `XADD` with the count cap on it,
the Cursor is the stream entry id, `read` is `XRANGE` strictly after it, `tail` is `XINFO STREAM`,
and the live feed is one `XREAD BLOCK` loop per Instance on a connection of its own. No Pub/Sub,
no Lua.

| Option             | Type                         | Default                                                     |
| ------------------ | ---------------------------- | ----------------------------------------------------------- |
| `url`              | `string`                     | `REDIS_URL`                                                 |
| `client`           | node-redis client            | none — the Transport connects its own                       |
| `prefix`           | `string`                     | `NEXT_SSE_PREFIX`, then `next-sse`                          |
| `retention`        | `{ window, cap }`            | `NEXT_SSE_RETENTION_WINDOW` / `_CAP`, then 300 s and 10 000 |
| `operationTimeout` | `number` (ms)                | `NEXT_SSE_OPERATION_TIMEOUT`, then 1000                     |
| `onError`          | `(error, operation) => void` | none — failures are still thrown to callers                 |
| `debug`            | `boolean`                    | `NEXT_SSE_DEBUG`                                            |

`operation` in `onError` is one of `connect`, `publish`, `read`, `tail`, `subscribe`, `trim`.

### Server version

**Redis ≥ 7.0 or Valkey ≥ 8.** The Transport decides `gone` on `recorded-first-entry-id` and
`entries-added`, both of which are Redis 7.0 fields; a server that reports neither is refused by
name at the first `XINFO STREAM` rather than answering a wrong `gone` quietly. Nothing past Redis
7.0 is used, which is what makes Valkey 8 a first-class target.

### The Prefix hazard

The Prefix is the **only** isolation between Apps on one server, and it sits inside the hash tag
so every key an App owns lands in one slot. Two Apps sharing a server under the default
`next-sse` Prefix deliver each other's Messages. **Set `NEXT_SSE_PREFIX` per App.** The database
index in the URL scopes nothing here.

### What not to do to the log

Do not delete the stream key, and do not `FLUSHALL`, while Instances are running. Deleting it
resets what the server reports about entries it dropped, so Cursors that pointed into the removed
range resume as if nothing had been missed instead of answering `gone`. Stop the Instances first,
or let retention do its work.

### Injected clients

```ts
import { createClient } from "redis";

createRedisTransport({ client: createClient({ url, socket: { tls: true } }) });
```

The caller keeps ownership: an injected client is never closed by the Transport, and the reader
runs on a `duplicate()` of it. Standalone, Cluster and Sentinel clients are recognised
structurally, and commands are handed to each one the way it takes them — a Cluster client gets
the routing key, a Sentinel client the read/write intent, always the master.

**Posture on Cluster and Sentinel, stated plainly**: those clients are accepted and routed
correctly, and that routing is covered by unit tests only. They have not been exercised against a
real Cluster or Sentinel topology. Standalone Redis and Valkey are what the integration suite runs
against on every push. Treat Cluster and Sentinel as best effort until that gap is closed.

### Error behaviour

Nothing is retried by the Transport. Every operation settles within `operationTimeout` and
rejects with one of:

| Error                       | When                                                  |
| --------------------------- | ----------------------------------------------------- |
| `TransportUnavailableError` | the backend is unreachable, or did not answer in time |
| `TransportClosedError`      | the Transport has been closed                         |
| `TransportError`            | the family; catch this to catch all three             |

A Transport outage mid-Connection does **not** drop clients: Connections are held open and
heartbeated for as long as it lasts, and the Instance resumes from its last position on recovery
— sending a Reset only if that position is gone. New connects during the outage are answered
`503` with `Retry-After`.

## The publisher half

```ts
import { createRedisPublisher } from "@flefebvre/next-sse/transport/redis";
import { createPublisher } from "@flefebvre/next-sse/transport";

import type { sse as app } from "../lib/sse";

const publisher = createRedisPublisher({ url: process.env.REDIS_URL });
const sse = createPublisher<typeof app>(publisher);

await sse.publish("chat:42", "message", { id: "1", text: "from the worker" });
await publisher.close();
```

`Publisher` is `publish`, `tail` and `close` — the write-only half, with no live feed and no
replay, so a worker holds exactly one connection. `createPublisher<typeof sse>` puts the App's
types over it through `import type`: the Channel name is checked against the App's patterns, the
event against what that Channel declares, and the payload against the schema's **Output**.

Nothing validates on this path — no Registry is present at runtime — so what a worker writes is
what a subscriber receives. It covers Messages only; a worker that must Kick writes the control
entry itself ([wire-format.md](wire-format.md)).

## Writing your own Transport

Five methods. Anything that is an ordered log will do — a database table, a queue, a message bus.

```ts
interface Transport {
  publish(entry: Entry): Promise<Cursor>;
  read(after: Cursor | undefined, limit: number): Promise<Page>;
  tail(): Promise<Cursor>;
  subscribe(
    listener: (entry: StoredEntry) => void,
    options: { onGap: (resumeFrom: Cursor) => void },
  ): Promise<Unsubscribe>;
  close(): Promise<void>;
}

type Page = { entries: StoredEntry[]; done: boolean } | { gone: true };
```

The obligations, all of them observable from outside:

1. **Cursors are yours, and opaque to everybody else.** You mint them; everything above compares
   them by equality only and never parses one. A Cursor from another log — or from a previous
   run — must be recognised as foreign.
2. **`read` pages strictly after a Cursor**, and says honestly whether the caller has caught up.
   `read(undefined, …)` means "from wherever the log now begins" and is never `gone`.
3. **`gone` is honest.** A Cursor pointing into what retention dropped answers `{ gone: true }` —
   never an arbitrary position. Erring toward `gone` costs a Reset; erring the other way loses
   Messages silently.
4. **`subscribe` delivers everything published after it resolved**, and `onGap` fires exactly once
   when the position it resumes from is gone, handed the oldest position the log can still serve.
   A log that cannot lose its reader's position never calls it. Listeners must not throw.
5. **Entries are round-tripped, not held.** What comes back out is a copy, as it would be from a
   backend that stored JSON.
6. **Retention is factory configuration** — `{ window, cap }`, defaulting to 300 s and 10 000 —
   and `tail()` answers the position after the last Entry, which for an empty log is the position
   before the first one.

Then prove it with the suite the shipped Transports are held to:

```ts
// lib/transport.test.ts
import { transportContract } from "@flefebvre/next-sse/testing";

import { createArrayLogTransport } from "./transport";

transportContract({ create: ({ retention }) => createArrayLogTransport({ retention }) });
```

A worked example of a Transport in about a hundred lines, with that suite beside it:
[patterns/custom-transport.md](patterns/custom-transport.md).
