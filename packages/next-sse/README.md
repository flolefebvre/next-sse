# @flefebvre/next-sse

Typed, authorization-aware pub/sub over Server-Sent Events for the Next.js App Router — on one
Instance, or on many behind a load balancer, with the same code.

**Requires** Next.js ≥ 16.3.0, React ≥ 19.2.0, Node ≥ 22.12. ESM only, App Router only.

## Why

Keeping an SSE stream alive in production is where the work is. Proxies buffer the response and
the page appears to hang. Connections die without the client noticing. Messages published while a
client was reconnecting, or while the app was being redeployed, are gone. A reconnect replays what
the client already had. Between a server component rendering its data and the stream going live
there is a window in which updates vanish. Fan-out breaks the moment the app runs on more than one
process. Rolling deploys hang on open streams.

This library is those problems, solved once. The claim is **gap-free delivery**: no Message lost
or delivered twice across reconnects, redeploys, or the server-render handoff. Channels are
declared in one server-only module with their event schemas and their authorization rule beside
them, so publishing and receiving are type-checked end to end; the transport is chosen from the
environment, and the manual ships inside the package.

## Install

```sh
pnpm add @flefebvre/next-sse
```

`redis` (node-redis v6) comes along as a plain dependency, imported lazily: an app on the Memory
Transport never loads it. Set `REDIS_URL` and the same code runs across many Instances on Redis or
Valkey. A schema library is optional — any [Standard Schema](https://standardschema.dev) validator
works, and `asType<T>()` covers events that need types without validation.

## For agents

Add this line to your `AGENTS.md` or `CLAUDE.md`:

```md
For @flefebvre/next-sse, read `node_modules/@flefebvre/next-sse/docs/index.md` first — it is the
manual for the exact installed version.
```

The full manual ships in the package, so what an agent reads is version-locked to the code next to
it. There is no separate skill content to go stale, and nothing prints at install time.

## Quickstart

### 1. Declare a Channel

```ts
// lib/sse.ts
import { initSSE } from "@flefebvre/next-sse/server";
import { z } from "zod";

import { sessionFrom, type Session } from "./session";

const { channel, createSSE } = initSSE({
  context: (request: Request): Session => sessionFrom(request.headers.get("cookie")),
  key: (session) => session.userId,
});

export const sse = createSSE({
  chat: channel({
    pattern: "chat:{roomId}",
    events: { message: z.object({ id: z.string(), text: z.string().min(1) }) },
    authorize: (params, session) => session.rooms.includes(params.roomId),
  }),
});
```

### 2. Serve the route

```ts
// app/api/sse/route.ts
import { sse } from "@/lib/sse";

export const { GET } = sse.handlers;
```

Mount `<SSEProvider sse={sse}>` once in a layout, and create the client half with
`createClient<typeof sse>()` in a `'use client'` module.

### 3. Publish from a server action

```ts
// app/actions.ts
"use server";

export async function send(roomId: string, text: string) {
  const message = appendMessage(roomId, text);
  await sse.chat({ roomId }).message(message);

  return message;
}
```

### 4. Render it live

```tsx
// app/page.tsx (Server Component)
const messages = await sse.snapshot(() => listMessages(roomId));

return <Messages roomId={roomId} snapshot={messages} />;
```

```tsx
// app/messages.tsx (Client Component)
const { state, status } = useChannelState(channels.chat({ roomId }), snapshot, {
  message: upsertBy("id"),
});
```

`sse.snapshot` takes the log's position **before** reading the data, so anything published between
that read and the stream going live is replayed to the page — exactly once. The overlap is
absorbed by `upsertBy("id")`.

## The package

Six subpaths, and no root export.

| Import from         | Holds                                                                         | Docs                              |
| ------------------- | ----------------------------------------------------------------------------- | --------------------------------- |
| `/server`           | `initSSE`, `SSEProvider`, `toClientChannels`, `asType`, `InvalidPayloadError` | [server.md](docs/server.md)       |
| `/client`           | `createClient`, `SSEClientProvider`, `upsertBy`                               | [client.md](docs/client.md)       |
| `/transport`        | the `Transport` contract, its errors, `createPublisher`                       | [transport.md](docs/transport.md) |
| `/transport/memory` | `createMemoryTransport`                                                       | [transport.md](docs/transport.md) |
| `/transport/redis`  | `createRedisTransport`, `createRedisPublisher`                                | [transport.md](docs/transport.md) |
| `/testing`          | `transportContract`, `FakeEventSource`, `snapshotOf`                          | [testing.md](docs/testing.md)     |

`/server` resolves to the implementation only under the `react-server` condition; imported
anywhere else it throws at module load, so a Client Component cannot pull the Registry — and
whatever the Registry imports — into the browser bundle.

## Going further

- [Setup](docs/setup.md) — install to first Message, with a Done-when checklist.
- [Core concepts](docs/core-concepts.md) — the eleven words the API uses.
- [Patterns](docs/patterns/index.md) — ten recipes, each linking the example app that runs it.
- [Deployment](docs/deployment.md) — proxy checklist, multi-Instance, redeploys, environment.
- [Wire format](docs/wire-format.md) — publish into an app from any language.
- [When not to use SSE](docs/when-not-to-use-sse.md) — and what to use instead.

On Redis and Valkey: the integration suite exercises standalone servers, a real three-master
cluster and a real master-plus-sentinel on every push (Redis 8 and Valkey 8; the floor is Redis
7.0 / Valkey 8), the last two through an injected `createCluster` or `createSentinel` client.
Failover of the blocking reader is the one thing not covered.

## License

MIT
