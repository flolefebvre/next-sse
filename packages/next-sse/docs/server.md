# Server reference

Everything in `@flefebvre/next-sse/server`. This entry has one target, the implementation, under
every condition: import it from Server Components, route handlers and other server code — and
from an App's own tests, which load it under plain Node. Client Components import
`@flefebvre/next-sse/client` instead.

An App that wants a Client Component import of its Registry to fail can put
`import "server-only"` at the top of that module; its tests then have to handle that package's
throw.

## `initSSE(options?)`

Configures the Instance and hands back the two factories the Registry is declared with.

```ts
const { channel, createSSE } = initSSE({
  context: (request) => sessionFrom(request.headers.get("cookie")),
  key: (session) => session.userId,
});
```

| Option        | Type                                        | Default   | What it does                                                                      |
| ------------- | ------------------------------------------- | --------- | --------------------------------------------------------------------------------- |
| `context`     | `(request: Request) => Ctx \| Promise<Ctx>` | none      | Built once per Connection; types every `authorize`. Omitted, `Ctx` is `undefined` |
| `key`         | `(ctx: Ctx) => string \| undefined`         | none      | The Connection's Key — what `sse.kick({ key })` addresses                         |
| `transport`   | `Transport`                                 | from env  | The log this App runs on. See [transport.md](transport.md)                        |
| `heartbeat`   | `number` (ms)                               | `15000`   | How often each Connection is sent a `heartbeat`. `0` turns it off                 |
| `maxLifetime` | `number` (ms)                               | `1800000` | Longest a Connection lives before a gap-free reconnect, ±10 %. `0` disables       |
| `drain`       | `number \| false` (ms)                      | `3000`    | The shutdown window. `false` installs no signal handlers, `0` closes at once      |

`context` is handed the `Request`, not `next/headers` — the SSE route handler is not free to use
those. Read the session from the request.

The Instance is one per process: `initSSE` called again during a hot reload reuses the Transport
and the Connection table that the open Connections are already on.

## `channel(declaration)`

Declares one Channel. The factory comes from `initSSE` so that `authorize` is typed with what
this App's `context` builds.

```ts
channel({
  pattern: "chat:{roomId}",
  events: { message: MessageSchema },
  authorize: (params, ctx) => ctx.rooms.includes(params.roomId),
});
```

**`pattern`** — the Channel name, with `{param}` placeholders. Params are inferred into the
Handle's argument type, so `chat:{roomId}` gives `sse.chat({ roomId })` and `announcements`
gives `sse.announcements()`. A param value may not contain `:` — that is the one character
reserved as a separator, and a Handle throws on it. Validate anything caller-supplied before you
fill a pattern with it.

**`events`** — a record of event name to [Standard Schema](https://standardschema.dev). zod 4,
valibot and arktype are all taken as they are; no schema library is a dependency of this one.
The schema's **Output** is bounded to JSON-serialisable values at declaration time, so a
`z.date()` payload is a compile error here rather than a string the client did not expect. Use
`asType<T>()` for an event that needs a type and no validation.

Reserved event names: `publish`, `snapshot`, `pattern`, `params`, `name` — a Handle already
answers to them.

**`authorize`** — `(params, ctx) => boolean | Promise<boolean>`, required. It runs once per
requested Channel when a Connection opens, and again on every reconnect. Never per Message. A
public Channel writes `() => true`, out loud, so a reader can tell public from forgotten.

Refusal is per Channel: the Connection carries on with the Channels that passed, and the refused
one surfaces as `status === "refused"` on its own hook. A Connection whose every Channel was
refused is closed. Denied and unknown Channels are indistinguishable on the wire.

## `createSSE(channels)`

Builds the Registry. It takes the Channel record and nothing else — all configuration is on
`initSSE`.

Two things it refuses, both at declaration time, both naming what to change:

- A Channel named after one of the Registry's own keys: `handlers`, `channels`, `cursor`,
  `snapshot`, `kick`, `drain`.
- **Two patterns that can produce the same Channel name.** One name is one stream of Messages,
  and two declarations over it means two typings of the same payload and two Authorize rules for
  the same Connection. `chat:{id}` beside `chat:admin`, or `{a}` beside `{b}`, is refused with
  both declarations named and a witness name quoted. The check is conservative in one corner: a
  pattern that repeats a param name (`{a}:{a}`) may be refused although no name is genuinely
  common — rename one of the params.

## The Registry

`createSSE` returns an object with the library's own members plus one Handle factory per
declared Channel.

| Member                   | What it is                                                                |
| ------------------------ | ------------------------------------------------------------------------- |
| `sse.handlers`           | `{ GET }` — re-export it from `app/api/sse/route.ts`                      |
| `sse.channels`           | the declarations, as declared; what `<SSEProvider>` strips for the client |
| `sse.snapshot(read)`     | read data with the Cursor taken first, for the server-render handoff      |
| `sse.cursor()`           | this request's Cursor, memoised per request. Rarely needed directly       |
| `sse.kick(target)`       | end Connections so they re-Authorize                                      |
| `sse.drain()`            | shut this Instance down and resolve when it is done                       |
| `sse.<channel>(params?)` | a bound Handle                                                            |

## Handles and publishing

A Handle is a Channel with its params filled in. Every declared event is a method on it.

```ts
const room = sse.chat({ roomId: "42" });

room.name; // "chat:42" — the Channel name on the wire, never the Registry key
await room.message({ id: "m1", text: "hello" }); // one Publish, returns the Cursor it minted
await room.publish("message", { id: "m2", text: "hi" }); // same, event name as data
```

There is no generic `sse.publish`. Publishing needs a Channel and its params, and a Handle is
that value.

A payload is the schema's **Input**: what you write, before validation. What travels the wire and
reaches the client is the **Output** the schema produced. A payload the schema refuses throws
`InvalidPayloadError`, carrying the validator's issues:

```ts
import { InvalidPayloadError } from "@flefebvre/next-sse/server";

try {
  await sse.chat({ roomId }).message({ id, text });
} catch (error) {
  if (error instanceof InvalidPayloadError) console.error(error.issues);
}
```

Validation happens on the Publish, which is **after** your write. Reject what the schema would
reject before you write, or a stored row can exist that no Connection was ever told about.

`publish` never retries. A Transport that is unreachable rejects with `TransportUnavailableError`
([transport.md](transport.md)).

## `sse.snapshot(read)` — the server-render handoff

```ts
const messages = await sse.snapshot(() => listMessages(roomId));
```

It takes the Cursor **before** running the read, and returns `{ data }` sealed as an opaque
`Snapshot`. Anything published between the read and the stream going live is after that Cursor,
so the Instance replays it and the page sees it exactly once. Nothing an App writes can get the
order wrong, because the App does not write it.

`sse.cursor()` is memoised with React's `cache`, so one render is one Cursor however many Server
Components mint Snapshots — and therefore one client reconnect. A page with nothing to read but
which still wants the guarantee can call `sse.snapshot(() => null)`.

It is not Server-Component-only: a server action mints one the same way, which is what a
component that refetches itself on Reset needs
([patterns/reset-override.md](patterns/reset-override.md)).

## `sse.kick(target)`

Ends Connections so they reconnect and go through Authorize again.

```ts
await sse.kick({ key: userId }); // every Connection this user holds, on every Instance
await sse.kick(sse.chat({ roomId })); // every Connection subscribed to chat:<roomId>
```

It writes one control entry to the log and resolves there — not when the Connections close: the
Instances that close them are on the far side of the log. Delivery is at-least-once and
live-only; a replay skips it.

Kicking by Key without a `key` function configured throws: nothing would know who holds a
Connection, and the revocation would silently match nothing.

A Kick carries no reason. An App that wants to explain publishes a Message on the user's own
Channel first, which arrives gap-free.

**When the session about to be re-Authorized is the one you just changed, Kick from the next
request, not the same one.** Setting cookies and Kicking your own Key in one server action is a
race between the `reconnect` on the open stream and the cookies in the action's response: if the
reconnect wins, the client re-Authorizes against the session it was just taken out of.
Kicking _another_ user has no such race. See
[patterns/kick.md](patterns/kick.md).

## `sse.drain()`

Shuts this Instance down: new connects answered `503`, every open Connection ended with
`reconnect` spread over the drain window, the Transport closed last. It resolves when that is
done, and is idempotent — a second call joins the Drain in flight.

Signal handlers for `SIGTERM` and `SIGINT` are installed by default and call it. Only a custom
server, or a test, calls it by hand. See [deployment.md](deployment.md).

## `<SSEProvider>` and `toClientChannels`

```tsx
<SSEProvider sse={sse} url="/stream">
  {children}
</SSEProvider>
```

A Server Component. It reads the Registry, strips it to the allowlist — each Channel's key,
pattern and event names — and passes that down as data. `url` is where the App serves the SSE
route (default `/api/sse`); it is client-side configuration only.

It takes no callback, because a Server Component cannot be handed one. To override what a Reset
does App-wide, compose the client provider yourself:

```tsx
// app/providers.tsx
"use client";

import { SSEClientProvider, type ClientChannels } from "@flefebvre/next-sse/client";
import type { ReactNode } from "react";

export function Providers({
  channels,
  children,
}: {
  channels: ClientChannels;
  children: ReactNode;
}) {
  return (
    <SSEClientProvider channels={channels} onReset={() => void refetchEverything()}>
      {children}
    </SSEClientProvider>
  );
}
```

```tsx
// app/layout.tsx
import { toClientChannels } from "@flefebvre/next-sse/server";

<Providers channels={toClientChannels(sse)}>{children}</Providers>;
```

## `asType<T>()`

An event typed by `T` alone, with no runtime validation.

```ts
import { asType } from "@flefebvre/next-sse/server";

events: {
  tick: asType<{ at: number }>(),
}
```

It is a real Standard Schema — `validate` hands the value straight back — so both sides treat it
like any other event. `T` carries the same JSON bound as a schema's Output: `asType<{ at: Date }>()`
is a compile error naming why.

## Publishing from outside Next.js

A worker, a cron runner or a queue consumer publishes into the same log with no Next.js and no
React in the process. `createPublisher<typeof sse>` over a Publisher gives it the App's types
through `import type`; see [transport.md](transport.md) and
[patterns/publish-from-a-worker.md](patterns/publish-from-a-worker.md). A service that does not
have this library at all writes the envelope directly:
[wire-format.md](wire-format.md).
