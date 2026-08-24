# Client reference

Everything in `@flefebvre/next-sse/client`. It is a `'use client'` entry: import it from Client
Components and from the one module that calls `createClient`.

## `createClient<typeof sse>()`

```ts
// lib/sse.client.ts
"use client";

import { createClient } from "@flefebvre/next-sse/client";

import type { sse } from "./sse";

export const { channels, useChannel, useChannelState } = createClient<typeof sse>();
```

The Registry arrives as a **type** and is erased with the `import type` it came in on. Nothing of
it exists at runtime here: which Channels exist, what params each pattern needs and what each
event's payload is are all type-level, and the Channel names themselves come from the provider's
data at render time.

`createClient` holds no state. Calling it once per App and exporting the result is a convention,
not a requirement.

## `channels` — client Handles

`channels.chat({ roomId })` is `{ key: "chat", params: { roomId } }`, typed against the Registry.
A Channel with no params takes no argument: `channels.announcements()`. The hook resolves the
Handle against the provider's patterns and gets the Channel name — `chat:42` — which is what
travels the wire.

Asking for a Handle the Registry does not declare is a type error; asking at runtime for a key
the provider does not carry throws, naming what it does carry.

## `useChannelState(handle, snapshot, reducers, options?)`

The primary shape: the hook owns the state.

```tsx
const { state, status, pending, inFlight, apply, act } = useChannelState(
  channels.chat({ roomId }),
  snapshot,
  { message: upsertBy("id") },
);
```

- **seeded** from `snapshot.data`;
- **advanced** by one reducer per event — `(state, payload) => state`; an event with no reducer
  leaves the state alone;
- **restarted** whenever a new Snapshot prop arrives, which is what closes the Reset loop: the
  route refreshes, the Server Component reads again at a fresh Cursor, the hook starts over.

Subscribing with a Snapshot makes the shared Connection reopen from the position that render read
at, so nothing published in between is lost. The cost is one reconnect per server render that
carries a Snapshot.

| Returns    | Type                                          |                                                                      |
| ---------- | --------------------------------------------- | -------------------------------------------------------------------- |
| `state`    | `Data`                                        | what the Snapshot and the reducers have made of it                   |
| `status`   | `Status`                                      | see below                                                            |
| `channel`  | `string`                                      | the resolved Channel name                                            |
| `apply`    | `(event, payload) => void`                    | run an event's reducer on a payload that did not come off the wire   |
| `act`      | `(event, optimistic \| null, action) => void` | the whole optimistic round in one call                               |
| `pending`  | `{ [event]: Payload[] }`                      | optimistic payloads still in flight, per event, empty lists included |
| `inFlight` | `boolean`                                     | whether an `act` is still running                                    |

`options` is `{ onReset? }`.

### `apply` and `act`

`apply` puts a payload through the same reducer a Message goes through — most often the result of
a server action, so what was just sent shows before its own echo arrives. The echo is then
absorbed by the reducer.

`act` folds `useOptimistic`, `useTransition` and `apply` together:

```tsx
act("message", { id: `pending-${Date.now()}`, text }, () => send(roomId, text));
```

The optimistic payload has the event's own wire shape — there is no second type for "not sent
yet" — and it shows for exactly as long as the transition lasts, with the real payload applied
before that transition ends, so the row never blinks. Pass `null` to send without an optimistic
payload.

## `useChannel(handle, handlers, options?)`

The low-level hook: it calls handlers, and the component owns whatever state it keeps.

```tsx
const { status } = useChannel(
  channels.notifications({ userId }),
  { arrived: (payload) => toast(payload.text) },
  { snapshot, onReset: () => void refetch() },
);
```

`options` is `{ snapshot?, onReset? }`. Without a Snapshot the hook is **live-only**: it is told
nothing of a replay until the Connection has caught up, because it has no way to tell a replayed
Message from one it already has.

## `Status`

`connecting` → `replaying` → `live`, plus `reconnecting` and `refused`.

| Value          | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `connecting`   | opening the Connection; the initial value of every hook                  |
| `replaying`    | the stream is open and delivering what happened since this hook's Cursor |
| `live`         | caught up; everything arriving now is current                            |
| `reconnecting` | the Connection dropped and is coming back                                |
| `refused`      | Authorize said no to this Channel. The rest of the page is unaffected    |

Reset is **not** a status: the Connection was live throughout.

## `upsertBy(key)`

The keyed-merge reducer: replace the item with the same key, or append it.

```ts
{
  message: upsertBy("id");
}
{
  message: upsertBy((item) => `${item.roomId}/${item.id}`);
}
```

One reducer covers every duplicate the library can hand a page — the Snapshot/replay overlap, a
Kick's replay, and the echo of a server action's own result — which is why the hooks have no
dedup option of their own.

## `Snapshot<Data>`

Opaque and serialisable. `sse.snapshot(read)` on the server is the only way to mint one; a hook
is the only way to spend one. The Cursor inside it is unreadable from App code, which is what
keeps the ordering rule an API rather than a paragraph. Tests mint one with `snapshotOf` from
`@flefebvre/next-sse/testing` ([testing.md](testing.md)).

## `<SSEClientProvider>`

What `<SSEProvider>` renders, exported for Apps that compose it themselves.

| Prop       | Type             | Default            |                                        |
| ---------- | ---------------- | ------------------ | -------------------------------------- |
| `channels` | `ClientChannels` | required           | as `toClientChannels(sse)` produces it |
| `url`      | `string`         | `"/api/sse"`       | where this App serves the SSE route    |
| `onReset`  | `() => void`     | `router.refresh()` | what a Reset means App-wide            |

Passing `onReset` is also what keeps `next/navigation` out of the tree — which is what lets a
component test render the provider with no App Router above it.

## One Connection per page

Every hook on the page shares one `EventSource`. Channel-set changes are coalesced on one
macrotask tick, so a render mounting five hooks opens one Connection, and React Strict Mode's
setup → cleanup → setup burst collapses to one connect with no development-only branch.

What the client does on its own, with no App code:

- the browser's own retry for a transient drop, resuming from `Last-Event-ID`;
- a watchdog: three heartbeat intervals with no bytes at all, and it reconnects;
- backoff from 1 s to 30 s with full jitter, forever, when the server answers something that is
  not a stream — short-circuited the moment the tab becomes visible;
- reconnect on the Instance's `reconnect` (a Kick, a Drain, the max lifetime);
- close on `pagehide`/`freeze`, reopen on `pageshow`/`resume`.

Every one of those resumes from the Cursor this client holds, so none of them can lose or repeat
a Message.

## Reset

A Reset means the position this Connection held is no longer in the log — it was trimmed while
the client was away — so the App's state may have holes and has to be read again. The default,
with no App code at all, is `router.refresh()`: the Server Components run again, mint fresh
Snapshots, and the new props restart the hooks.

Override it App-wide with `onReset` on `<SSEClientProvider>`, or for one component by passing
`onReset` to its hook — typically to refetch just that component's data and re-seed it:
[patterns/reset-override.md](patterns/reset-override.md).
