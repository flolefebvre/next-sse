# PROTOTYPE: client DX for the chat use case

Throwaway playground for [issue #13](https://github.com/flolefebvre/next-sse/issues/13) (map [#1](https://github.com/flolefebvre/next-sse/issues/1)). **Not production code**: `lib/next-sse/` is a fake `next-sse` with just enough runtime (memory log, `GET` handler speaking ADR-0004, `EventSource` core) to make the App-side files real and runnable in a Next 16.3 app.

**Question.** What is the smallest amount of client code a developer writes to make a server-rendered list live, with no gap between the server component's read and the Connection going live, and what do Reset and reconnection look like to them?

## Run

```sh
cd prototypes/client-dx
pnpm install
pnpm dev          # http://localhost:3000/chat/general?variant=a   (← → keys or the bottom bar switch variants)
pnpm check        # tsc: every @ts-expect-error in app/types-check.ts must fire
```

Open two browser windows on the same room to see fan-out. The **debug panel** (bottom right) provokes every situation the ADRs describe and shows the core's trace: out-of-band Publish, Kick, dropped Connection (native reconnect with `Last-Event-ID`), Cursor gone (→ `reset` → `router.refresh()`), server restart. `#secret` is refused unless you are `admin` (name box, top right). The fake db read takes 800 ms on purpose so the SSR→SSE window is wide: click "Publish out-of-band" in one window while the other is loading.

All three variants were driven headlessly through: overlap (a Message published during the server render arrives exactly once), send, out-of-band, drop + 3 Messages while away (replayed, no duplicates), Kick, Reset, server restart.

## The three variants

Each is a pair of files under `app/chat/[roomId]/_variants/<x>/`: `room.tsx` (server component) and `chat-room.tsx` (client). They share `../shared.tsx` (list, status pill, a **live-only** typing indicator) and the same `app/sse.ts` Registry / `app/sse.client.ts` two-liner from #8.

| | **A: handlers, your state** | **B: snapshot + reducers** | **C: Handle-bound snapshot** |
|---|---|---|---|
| Server | `const cursor = await sse.cursor()`<br>`const messages = await db.list(roomId)`<br>`<ChatRoom key={cursor} initial cursor />` | `const snapshot = await sse.snapshot(() => db.list(roomId))`<br>`<ChatRoom snapshot={snapshot} />` | `const live = await chat({ roomId }).snapshot(() => db.list(roomId))`<br>`<ChatRoom live={live} />` |
| What crosses | `Message[]` + `cursor: string` | `{ data, cursor }` | `{ channel, cursor, data }` (typed with the Channel's events) |
| Client | `const [messages, setMessages] = useState(initial)`<br>`useChannel(channels.chat({ roomId }), { message: (m) => setMessages(ms => upsert(ms, m)) }, { cursor, onReset: () => router.refresh() })` | `const { state, status } = useChannelState(channels.chat({ roomId }), snapshot, { message: upsertBy('id') })` (prop typed `Snapshot<Message[]>`) | `const [messages, { status, apply }] = useLive(live, { message: (ms, m) => upsert(ms, m) })` |
| Who owns the state | you | the hook, restarted when a new `snapshot` prop arrives | the hook, same |
| Reset | you: `onReset` → `router.refresh()`; `key={cursor}` remounts with the new data | nothing: provider default `router.refresh()`, new snapshot restarts the state | nothing, same |
| Handle on the client | yes | yes | **no**: the snapshot says which Channel |
| Optimistic send | plain server action | `useOptimistic` + `apply('message', await postMessage(...))` (added in round 3) | `useOptimistic` + `apply('message', await postMessage(...))` |
| Lines in the client component for "live" | 5 | 3 | 3 |

What every variant shares underneath (`lib/next-sse/core.ts`): one `EventSource` for all hooks on the page (the typing indicator rides on the chat Connection), Channel-set changes coalesced on one tick, `lastEventId` owned by the core, `ready` / `caught-up` / `reset` / `reconnect` / `heartbeat` handled there, non-200 backoff, watchdog at 3× heartbeat. Status per hook: `connecting → replaying → live`, `reconnecting`, `refused`.

## Things to react to

1. **Server handoff: which shape survives a real page?** A's two lines + `key={cursor}` are explicit and idiomatic React (a new Cursor is a new page state, so remount) but the order "Cursor before read" is on the developer. B's `sse.snapshot(read)` enforces the order and costs nothing. C's `chat({ roomId }).snapshot(read)` also fixes the Channel, so the client needs no Handle and gets typed reducers from one prop. Note `sse.cursor()` is **per-request cached** (React `cache`): every server component in one render gets the same Cursor, so a page with three live lists hands the client one Cursor, not three.
2. **The rule this prototype adds: a hook subscribing with a Cursor makes the shared Connection (re)open from that Cursor.** That is what makes "new snapshot after `router.refresh()`" gap-free without the client ever comparing Cursors (ADR-0001): the server replays strictly after it, duplicates are absorbed by the reducer. Cost: one reconnect per server-component render that carries a Cursor (initial load, a Reset, any `revalidatePath`, a client-side navigation to a page with a live list). A client-side ring buffer was considered and does not work: the Cursor the server hands out is the log's tail, usually an Entry on a Channel the client never received, so the client cannot find it by equality. Is one reconnect per server render acceptable for v0.1?
3. **No `key: (m) => string` option; `upsertBy` sugar instead** (added in round 2 on request). Variant B now reads `message: upsertBy('id')`; `upsertBy((m) => m.id)` also works and contextual inference types `m` as `Message` (verified: `m.nope` is a compile error). A/C keep the hand-written `upsert` for contrast.
4. **Reset, as the developer sees it.** A: one option, `onReset: () => router.refresh()` (and `key={cursor}`). B/C: zero code; the provider's default refetches, and a hook can override. In all three the list briefly shows stale data while the server re-reads (800 ms here). Is "refetch everything" the right App-wide default, and should a Reset surface in `status` at all (currently it does not: the Connection stays `live`)?
5. **Reconnection is invisible** except through `status`. `replaying → live` is the "caught up" signal; `reconnecting` covers native drops, non-200 backoff, Kick and watchdog alike. Enough? Does anyone need the reason?
6. **Live-only reads as intended?** `TypingIndicator` is `useChannel(channels.chat({ roomId }), { typing })` with no options. Rule implemented: a hook without a Cursor ignores replayed Entries until the first `caught-up` after it mounted, then follows every reconnect like any other hook. (Observed in the trace: the browser's own `Last-Event-ID` is empty until a Message with `id:` has been received, so the `?cursor=` in the URL is what makes a native reconnect gap-free on a quiet Channel; ADR-0004's "3 s window" only bites when the core opened live-only.)
7. **Optimistic.** A `useOptimistic` pending row disappears when the action resolves, which can be a frame before the SSE echo lands (a flicker). `apply('message', result)` puts the real row in the list from the action's return value, and the echo is absorbed by `upsertBy`. Round 3: B gained `apply` on request, same shape as C's. Round 4: `act(event, optimistic, action)` folds useOptimistic + useTransition + apply into one call (`pending` grouped per event, `inFlight` boolean); `apply` stays for finer control.
8. **Type plumbing.** C's prop type `SnapshotOf<typeof sse, 'chat', Message[]>` is the ugliest line in the prototype. A and B type their props by hand (`Message[]`, `{ data: Message[]; cursor: string }`). Acceptable?
9. **Handler signature** in A is `(payload, phase)` with `phase: 'replay' | 'live'`. Nobody used `phase` here; drop it?
10. **Hook names**: `useChannel` / `useChannelState` / `useLive` are placeholders so the variants can be told apart; the winner gets the good name.

## Not in this prototype

`pagehide`/`pageshow` handling, the max-lifetime `reconnect`, a real Transport; the core's backoff constants are ADR-0004's but only the watchdog was exercised (heartbeat is 5 s here).
