# Setup

From an empty App to a Message on screen. Every file below is the whole file.

## Requirements

Next.js ≥ 16.3.0 (App Router), React ≥ 19.2.0, Node ≥ 22.12, ESM. Below Next.js 16.3.0 the
server leaks memory when a client disconnects, which is why the floor is a hard one.

## 1. Install

```sh
pnpm add @flefebvre/next-sse
```

`redis` (node-redis v6) comes with it as a plain dependency — nothing to install for the
multi-Instance path, and nothing loaded for the single-Instance one: the Redis Transport is
imported lazily, only when `REDIS_URL` is set.

A schema library is optional. Any [Standard Schema](https://standardschema.dev) validator works
— zod 4, valibot, arktype — and `asType<T>()` covers events that need types without validation.

## 2. Declare the Registry

One server-only module. This is where Channels, their events and their Authorize live, together.

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
    authorize: () => true,
  }),
  notifications: channel({
    pattern: "notifications:{userId}",
    events: { arrived: z.object({ id: z.string(), text: z.string().min(1) }) },
    authorize: (params, session) => params.userId === session.userId,
  }),
});
```

`context` runs once per Connection and types every `authorize` in the Registry. `key` derives the
Connection's Key from it — the identity a Kick addresses. An App whose Channels are all public
writes neither.

All configuration lives on `initSSE` (`context`, `key`, `transport`, `heartbeat`, `maxLifetime`,
`drain`); `createSSE` takes the Channels and nothing else. Full reference:
[server.md](server.md).

## 3. Serve the route

```ts
// app/api/sse/route.ts
import { sse } from "@/lib/sse";

export const { GET } = sse.handlers;
```

One `GET` per Connection. The default path the client looks for is `/api/sse`; serve it
somewhere else and pass `url` to the provider — the handler itself has no path.

## 4. Mount the provider

```tsx
// app/layout.tsx
import { SSEProvider } from "@flefebvre/next-sse/server";
import type { ReactNode } from "react";

import { sse } from "@/lib/sse";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SSEProvider sse={sse}>{children}</SSEProvider>
      </body>
    </html>
  );
}
```

`<SSEProvider>` is a Server Component. It is the only place the Registry crosses toward the
client, and it strips it to an allowlist — each Channel's pattern and its event names — which it
passes down as a prop. Authorize, the schemas and whatever the Registry imports stay on the
server.

## 5. Create the client half

```ts
// lib/sse.client.ts
"use client";

import { createClient } from "@flefebvre/next-sse/client";

import type { sse } from "./sse";

export const { channels, useChannel, useChannelState } = createClient<typeof sse>();
```

`import type` is load-bearing: the Registry reaches this module as a type and is erased before
the bundler sees it.

## 6. Publish

From a server action, a Route Handler, or anywhere else server-side. Write first, publish second.

```ts
// app/actions.ts
"use server";

import { appendMessage } from "@/lib/messages";
import { sse } from "@/lib/sse";

export async function send(roomId: string, text: string) {
  const message = appendMessage(roomId, text);
  await sse.chat({ roomId }).message(message);

  return message;
}
```

## 7. Render it live

The Server Component reads the data through `sse.snapshot`, the Client Component turns it into
live state.

```tsx
// app/page.tsx
import { listMessages } from "@/lib/messages";
import { sse } from "@/lib/sse";

import { Messages } from "./messages";

export default async function Page() {
  const messages = await sse.snapshot(() => listMessages("42"));

  return <Messages roomId="42" snapshot={messages} />;
}
```

```tsx
// app/messages.tsx
"use client";

import { upsertBy, type Snapshot } from "@flefebvre/next-sse/client";

import { channels, useChannelState } from "@/lib/sse.client";

export function Messages({
  roomId,
  snapshot,
}: {
  roomId: string;
  snapshot: Snapshot<{ id: string; text: string }[]>;
}) {
  const { state, status } = useChannelState(channels.chat({ roomId }), snapshot, {
    message: upsertBy("id"),
  });

  return (
    <>
      <p>{status}</p>
      <ul>
        {state.map((message) => (
          <li key={message.id}>{message.text}</li>
        ))}
      </ul>
    </>
  );
}
```

`upsertBy("id")` is the whole of the duplicate handling: the overlap between the Snapshot and the
replay, a reconnect's replay, and the echo of what this page just sent are the same item twice.

## Transport: zero-config, or a factory

Nothing above named a Transport. The App gets one from its environment:

| `REDIS_URL`      | Transport      | Good for                                   |
| ---------------- | -------------- | ------------------------------------------ |
| unset            | Memory         | development, and single-Instance production |
| `redis://…`      | Redis / Valkey | any deployment with more than one Instance |

Pass one explicitly when the environment cannot say everything — an injected client, a
per-App Prefix in code, custom retention:

```ts
import { createRedisTransport } from "@flefebvre/next-sse/transport/redis";

const { channel, createSSE } = initSSE({
  transport: createRedisTransport({ prefix: "billing-app" }),
});
```

Explicit configuration wins over the environment, field by field. See
[transport.md](transport.md) for every option and [deployment.md](deployment.md) for the
environment table.

## Cache Components

With `cacheComponents` on, a Server Component that reads no request data is prerendered at build
— and a Snapshot baked into HTML resumes from a Cursor that is days old. Read something from the
request (`cookies()`, `headers()`) in any component that mints a Snapshot. The SSE route handler
needs nothing: it reads the request URL as its first act.

## Done when

- [ ] `lib/sse.ts` exports `sse` from `createSSE`, and every Channel declares `authorize`.
- [ ] `app/api/sse/route.ts` re-exports `sse.handlers` — and nothing else opens a stream.
- [ ] `<SSEProvider sse={sse}>` is mounted once, in a layout above every subscriber.
- [ ] A `'use client'` module calls `createClient<typeof sse>()` with `import type`.
- [ ] Every Server Component that seeds a hook reads through `await sse.snapshot(read)`, and
      passes the result down as a prop.
- [ ] Publishes go through Handles (`sse.chat({ roomId }).message(...)`), after the write.
- [ ] Opening the page shows `status` reaching `live`, and a publish from another tab arrives
      without a refresh.
- [ ] More than one Instance in production? `REDIS_URL` is set, and `NEXT_SSE_PREFIX` is this
      App's own if the server is shared.
