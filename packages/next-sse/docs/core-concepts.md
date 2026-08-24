# Core concepts

Eleven words carry the whole library. They are used exactly this way in the API, in error
messages and in the rest of this manual.

## App

One Next.js application using the library. Several Apps can share one Redis or Valkey server;
the Prefix is what keeps them apart.

## Instance

One running server process of an App. A deployment behind a load balancer is several Instances
of the same App. Everything works the same with one Instance and with ten — the difference is
which Transport carries Messages between them.

## Channel

A named stream of Messages that Connections subscribe to and server code publishes to. A Channel
name is a plain string (`chat:42`, `announcements`, `notifications:u-7`). Per-user and per-entity
Channels are naming conventions, not separate features.

Channels are declared once, in the Registry, with a pattern: `chat:{roomId}` is a family, and
`chat({ roomId: "42" })` is one member of it.

## Message

One unit published to a Channel: an event name, declared by the Channel, and a payload the
Channel's schema validated.

```ts
await sse.chat({ roomId: "42" }).message({ id: "m1", text: "hello" });
//         ^ Channel               ^ event   ^ payload
```

## Registry

The App's single server-only declaration of every Channel it has — pattern, events, Authorize —
built by `createSSE`. It is the source of truth for types on both sides, and the only module
that ever imports the App's session or database code for this purpose.

## Connection

One open SSE connection from a browser to an Instance, carrying the set of Channels that client
subscribes to. **One page holds one Connection**, however many hooks it mounts: the client
coalesces them.

## Authorize

The App's decision whether a Connection may subscribe to a given Channel. It runs per Channel
when the Connection opens and again on every reconnect — never per Message. A Channel it refuses
is dropped from the Connection and reported to that one hook as `refused`; the rest of the page
keeps streaming.

## Key

The opaque identity the App gives a Connection, derived once from the request — usually a user
or session id. It is the only thing the library knows about who holds a Connection, and what a
Kick addresses.

## Cursor

The opaque, Transport-minted position in the App's Message flow that a Connection resumes from.
One Cursor per Connection, covering all its Channels. App code never sees one: it travels inside
a Snapshot, and inside the SSE `id:` field.

## Snapshot

The one value a Server Component hands the client to make server-rendered data live: the data it
read, and the Cursor taken **just before** that read.

```tsx
const messages = await sse.snapshot(() => listMessages(roomId));
return <Messages snapshot={messages} />;
```

That order is the whole handoff. Anything published between the read and the stream going live
sits after the Cursor, so the Instance replays it and the page sees it exactly once.

## Transport

The pluggable backend that carries Messages between Instances: one ordered, bounded log per App
that every Instance reads in full, with Cursors it mints itself. It knows nothing about Channels'
meaning, Authorize or Connections — routing, replay and deduplication all live in the Instance.

- **Memory** — one process, no backend. Chosen when `REDIS_URL` is unset.
- **Redis/Valkey** — many Instances, one Redis Stream. Chosen when `REDIS_URL` is set.
- **Yours** — five methods; see [transport.md](transport.md).

## The guarantee

**Gap-free delivery.** Between the moment a Connection first takes a position and the moment it
is closed for good, no Message on its Channels is lost or delivered twice — across network
drops, laptop sleep, a Kick, a redeploy, or the server-render handoff.

It rests on three things, none of which the App writes:

1. Every Connection carries a Cursor, and every reconnect resumes strictly after it.
2. The Instance cuts the replay where it meets the live feed, by Cursor equality.
3. What the log can no longer serve is answered honestly as `gone`, which becomes a Reset —
   the client refetches instead of silently missing Messages.

Ordering **per Channel** is promised. Global ordering across Channels happens to hold in v0.1 and
is deliberately not promised.

## Control events

In-band signals from the library to the client, belonging to no Channel and never replayed:
`ready`, `heartbeat`, `reconnect`, `caught-up`, `reset`. An App never handles them; they are
listed here because they show up when you read a stream by hand
([wire-format.md](wire-format.md)).

## Kick, Drain, Reset

- **Kick** — server code ends Connections so they come back and go through Authorize again.
  Addressed by Key or by Channel, reaches every Instance.
- **Drain** — an Instance's shutdown: refuse new connects, end open Connections with `reconnect`
  spread over a window, close the Transport last.
- **Reset** — the signal that a Connection's Cursor is unusable (too old, unknown). The App
  refetches; by default the provider calls `router.refresh()`, which re-mints Snapshots.
