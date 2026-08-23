# node-redis v6 on Redis 7+ / Valkey 8: fan-out and buffered replay

Research for issue #2 (part of #1). Date: 2026-08-23.

Question: what does node-redis v6 give the Redis Transport, on Redis 7+ and Valkey 8, to (a) fan Messages out to every Instance of an App and (b) keep a bounded, replayable buffer so a reconnecting Connection resumes from a cursor without loss or duplication?

Versions examined:

- `redis@6.2.1` / `@redis/client@6.2.1` — latest release, 2026-08-11 ([releases](https://github.com/redis/node-redis/releases)); source read on `master` of [redis/node-redis](https://github.com/redis/node-redis) under `packages/client/lib/`, referred to below as `lib/`.
- Server docs: [redis/docs](https://github.com/redis/docs) `main` (describes up to Redis 8.10), [valkey-io/valkey-doc](https://github.com/valkey-io/valkey-doc) `main`, the Valkey `8.0.0` tag, and the Redis `8.0.0` release notes. Latest Valkey releases on 2026-07-21: 9.1.1, 9.0.5, 8.1.9, 8.0.10, 7.2.14 ([releases](https://github.com/valkey-io/valkey/releases)).
- Sibling: [flolefebvre/nextjs-redis-cache-handler](https://github.com/flolefebvre/nextjs-redis-cache-handler) `main`, pinned to `"redis": "^6.2.1"` ([package.json](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/package.json)).

Nothing below was probed against a live server in this ticket; every claim is from docs or source. The one set of live probes cited is the sibling's ([node-redis-capabilities.md](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/docs/research/node-redis-capabilities.md)). Facts that could not be sourced are marked **unsourced** and repeated under Open questions.

## Summary

1. **Pub/Sub alone cannot be gap-free.** Redis Pub/Sub is at-most-once: a message not delivered (subscriber disconnected, output buffer overrun) "is forever lost" ([Redis pubsub](https://redis.io/docs/latest/develop/pubsub/#delivery-semantics)). node-redis does resubscribe on reconnect, but everything published while the socket was down is gone. A replay buffer must live somewhere else, and the Redis primitive for it is a Stream.
2. **A Stream is a complete cursor/replay primitive.** `XADD` IDs are `ms-seq`, strictly increasing per stream even across clock jumps; `XRANGE (cursor +` and `XREAD STREAMS key cursor` both return strictly-after-cursor entries; `XADD … MAXLEN ~ N` / `MINID ~ ms` bound it; `XINFO STREAM` exposes `first-entry` and `max-deleted-entry-id` to detect a cursor that fell off the buffer.
3. **`XREAD BLOCK` fans out**: "this command fans out to all the clients that are waiting for the same range of IDs, so every consumer will get a copy" ([XREAD](https://redis.io/docs/latest/commands/xread/)). One blocking reader per Instance on the App's stream gives every Instance everything, in order, with a per-Instance cursor that survives that Instance's own Redis reconnects — which Pub/Sub cannot offer.
4. **node-redis v6 subscriber behaviour**: Pub/Sub takes over a RESP2 connection, so it needs a dedicated client from `client.duplicate()`; RESP3 (the v6 default) lets the server accept commands while subscribed, but node-redis documents only the dedicated-connection path. On every new socket the client re-issues `SUBSCRIBE`/`PSUBSCRIBE`/`SSUBSCRIBE` for all registered listeners before `ready` (`lib/client/index.ts` `#initiateSocket`). A `duplicate()` needs its own `error` listener and its own `connect()`.
5. **Cluster**: `PUBLISH` is broadcast to every node over the cluster bus; `SPUBLISH`/`SSUBSCRIBE` are slot-bound (hash-tag rules identical to keys). node-redis `createCluster` supports both: one random-node connection for classic Pub/Sub, one connection per master for sharded, `MOVED` retried up to `maxCommandRedirections` (16), `sharded-channel-moved` handled. Stream keys are slot-bound anyway, so one `{Prefix}` hash tag pins stream and shard channel to one slot.
6. **Valkey 8** is "fully compatible with Redis OSS 7.2.4", reports `redis_version:7.2.4` plus `valkey_version`, speaks RESP2/RESP3, has `MINID`/`NOMKSTREAM`/`LIMIT` (6.2) and sharded Pub/Sub (7.0). It lacks the Redis 8.2+/8.6/8.10 stream extras (`KEEPREF`/`ACKED`, `IDMP`, `MAXCOUNT`/`MAXSIZE`), none of which this library needs. Licence: BSD-3 vs Redis 8's RSALv2/SSPLv1/AGPLv3.
7. **Scoping**: Pub/Sub "has no relation to the key space… including database numbers. Publishing on db 10, will be heard by a subscriber on db 1" — confirmed in both Redis and Valkey docs. node-redis `keyPrefix` does not touch channel names. The Prefix must therefore be embedded in channel and key names by the library; the cache handler already does this with a verbatim prefix and a `{…}` hash tag.
8. **Cost of one channel per App**: `PUBLISH` is O(N+M) (N subscribers on the channel, M patterns anywhere); every Publish is copied once per Instance, so egress is `I × payload` per Message and each Instance parses Messages it may route nowhere. Slow Instances hit `client-output-buffer-limit pubsub 32mb 8mb 60` and get disconnected (losing messages) — identical defaults in `redis.conf` and `valkey.conf`. A stream reader pulls at its own pace instead.
9. **Cache handler posture** worth mirroring verbatim: `connectTimeout 2 s`, `socketTimeout 15 s`, `pingInterval 10 s`, `disableOfflineQueue: true`, a reconnect strategy that never returns `false` (the default gives up forever on `SocketTimeoutError`), a mandatory `error` listener, lazy connect, `unref()`, `withDeadline` around whole operations because node-redis's `commandOptions.timeout` only covers commands not yet written, and a closed list of retryable reply codes.

## 1. Pub/Sub vs Streams

### 1.1 Pub/Sub

All from [Redis pubsub](https://redis.io/docs/latest/develop/pubsub/); the [Valkey page](https://valkey.io/topics/pubsub/) is the same text with the product name changed:

- "Subscribers receive the messages in the order that the messages are published."
- "A client subscribed to one or more channels shouldn't issue commands, although it can SUBSCRIBE and UNSUBSCRIBE." In RESP2 only `PING`, `(P|S)SUBSCRIBE`, `(P|S)UNSUBSCRIBE`, `QUIT`, `RESET` are accepted. "However, if RESP3 is used (see HELLO), a client can issue any commands while in the subscribed state."
- "Redis' Pub/Sub exhibits at-most-once message delivery semantics… If the subscriber is unable to handle the message (for example, due to an error or a network disconnect) the message is forever lost. If your application requires stronger delivery guarantees, you may want to learn about Redis Streams."
- "Pub/Sub has no relation to the key space. It was made to not interfere with it on any level, including database numbers. Publishing on db 10, will be heard by a subscriber on db 1. If you need scoping of some kind, prefix the channels with the name of the environment."
- A client subscribed to both a channel and a matching pattern receives the message twice (`message` + `pmessage`).
- [`PUBLISH`](https://redis.io/docs/latest/commands/publish/): "O(N+M) where N is the number of clients subscribed to the receiving channel and M is the total number of subscribed patterns (by any client)." Returns the number of clients it was sent to; "in a Redis Cluster, only clients that are connected to the same node as the publishing client are included in the count."
- Slow subscribers: `client-output-buffer-limit pubsub 32mb 8mb 60` — "A client is immediately disconnected once the hard limit is reached, or if the soft limit is reached and remains reached for the specified number of seconds" ([redis.conf](https://github.com/redis/redis/blob/unstable/redis.conf), same line in [valkey.conf@8.0.0](https://github.com/valkey-io/valkey/blob/8.0.0/valkey.conf)). The class is "clients subscribed to at least one pubsub channel or pattern", so a RESP3 connection that mixes commands and subscriptions is governed by the pubsub limit too.

Consequence for the map's hard requirement: an Instance whose Redis socket drops loses every Message published between the drop and the resubscribe (§2.2), and a slow Instance can be cut off by the server. Pub/Sub is a wake-up signal, not a buffer.

### 1.2 Streams

From [XADD](https://redis.io/docs/latest/commands/xadd/), [XRANGE](https://redis.io/docs/latest/commands/xrange/), [XREAD](https://redis.io/docs/latest/commands/xread/), [XTRIM](https://redis.io/docs/latest/commands/xtrim/), [XINFO STREAM](https://redis.io/docs/latest/commands/xinfo-stream/) and the [streams intro](https://redis.io/docs/latest/develop/data-types/streams/):

**IDs.** `<ms>-<seq>`, both 64-bit; `*` auto-generates from the server clock. "Redis guarantees that IDs are always incremental… if the current top ID in the stream has a time greater than the current local time of the instance, Redis uses the top entry time instead and increments the sequence part" — monotonic through clock jumps and failovers. An incomplete ID (`<ms>` only) is read as `<ms>-0`. The ID is generated on the Redis clock, not the Instance's (the cache handler made the same choice in [ADR-0002](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/docs/adr/0002-entry-write-time-on-redis-clock.md)).

**Replay (`XRANGE`).** Inclusive by default; "It is possible to specify an open interval (exclusive) by prefixing the ID with the character `(`. This is useful for iterating the stream." `-`/`+` are min/max. `COUNT` caps the page; iterate with `XRANGE key (lastId + COUNT n`.

**Tail (`XREAD`).** "returning only entries with an ID greater than the last received ID reported by the caller" — always exclusive, no `(` needed. `BLOCK ms` (0 = forever) waits for new entries; when data is already available "the command is executed synchronously exactly like if the BLOCK option would be missing". `$` means "only new entries from now" and must be used "only for the first call… Later the ID should be the one of the last reported item in the stream, otherwise you could miss all the entries that are added in between." Fan-out: "this command fans out to all the clients that are waiting for the same range of IDs, so every consumer will get a copy of the data, unlike to what happens when blocking list pop operations are used." `+` (last entry) exists on Redis and on Valkey 8 ("Introduce `+` as a special ID for the last item in stream on XREAD", [Valkey 8.0 notes](https://github.com/valkey-io/valkey/blob/8.0.0/00-RELEASENOTES)).

**Retention.** `XADD key [NOMKSTREAM] [MAXLEN|MINID [=|~] threshold [LIMIT n]] * field value…` trims in the same call. `MAXLEN` keeps the newest N entries; `MINID` "Evicts entries with IDs lower than the specified threshold" (6.2+). `~` is approximate: "the stream contains only 1000 entries, or at most a few tens more" and is "much more efficient" because streams are radix trees of macro nodes. There is no time-based retention: "There is currently no option to tell the stream to just retain items that are not older than a given period"; `MINID <now_ms - window_ms>` against the server's `TIME` is the way to express it. An empty stream key is not deleted ("Streams… are allowed to stay at zero elements"). Streams are replicated and persisted like any key; "AOF must be used with a strong fsync policy if persistence of messages is important" — for a replay buffer that is acceptable, the buffer is not the source of truth.

**Detecting a stale cursor.** `XINFO STREAM` returns `length`, `last-generated-id`, `first-entry`, and since 7.0.0 `max-deleted-entry-id`, `entries-added`, `recorded-first-entry-id` (version from the `history` block of [XINFO STREAM](https://redis.io/docs/latest/commands/xinfo-stream/) — node-redis's inline comment says "7.2+", which is off; field list in [`lib/commands/XINFO_STREAM.ts`](https://github.com/redis/node-redis/blob/master/packages/client/lib/commands/XINFO_STREAM.ts); same fields on [Valkey](https://valkey.io/commands/xinfo-stream/)). A cursor older than `first-entry`'s ID (or ≤ `max-deleted-entry-id`) means entries were trimmed between the client's last Message and now: replay is incomplete and the Connection must be told to resync rather than silently resume. Cheaper alternative without `XINFO`: `XRANGE key - + COUNT 1` and compare.

### 1.3 Cursor semantics for a Connection

- Cursor = the stream ID of the last Message the Connection received, an opaque string (`"1724400000000-3"`). Strictly increasing; compare as two integers, not lexically.
- Resume = `XRANGE key (cursor + COUNT n` (paged), then live. Exactly-once is then a pure ID comparison on the Instance: drop anything ≤ last delivered ID. That dedupe is what lets the live feed and the replay overlap without double delivery.
- On the wire, SSE already carries this: the `id:` field sets "the last event ID buffer", and "The `Last-Event-ID` HTTP request header reports an EventSource object's last event ID string to the server when the user agent is to reestablish the connection" ([WHATWG](https://html.spec.whatwg.org/multipage/server-sent-events.html)). The native `EventSource` sends the stream ID back for free, and `retry:` sets the reconnect delay.
- A brand-new Connection rendered from a server component needs the cursor *at render time* (`XREVRANGE key + - COUNT 1`, or the ID returned by the last `XADD`) baked into the page, so the window between render and Connection-live replays from that ID. That is the second gap the map names; the stream covers it with the same mechanism.

### 1.4 Designs compared

| | A. Pub/Sub only | B. Stream only (`XREAD BLOCK` loop per Instance) | C. Pub/Sub wake-up + Stream buffer |
|---|---|---|---|
| Gap-free across client reconnect | no | yes (replay from cursor) | yes (replay from cursor) |
| Gap-free across the **Instance's** Redis reconnect | no (lost until resubscribe) | yes — reissue `XREAD` with the same last ID | only if the Instance replays after every `reconnecting` |
| Writes per Publish | 1 (`PUBLISH`) | 1 (`XADD … MAXLEN ~`) | 2 (`XADD` then `PUBLISH` carrying the ID, or one Lua script) |
| Live latency | push | unblocks on `XADD`, one round-trip per batch | push |
| Dedicated connection per Instance | 1 (subscriber) | 1 (blocked reader) | 1 (subscriber) |
| Slow Instance | disconnected at 32 mb / 8 mb·60 s, messages lost | reads at its own pace; nothing lost inside the buffer window | as A for the live path |
| Ordering | per channel | total order by ID | two paths; merge by ID |
| Cluster | `PUBLISH` broadcast or `SPUBLISH` slot-bound | key-bound, one slot | both |
| Memory | none | bounded by `MAXLEN`/`MINID` | same |

B and C both satisfy the map; B does it with one primitive, one write, and no merge logic. See Recommendation.

## 2. Subscriber connections in node-redis v6

### 2.1 Dedicated connection and `duplicate()`

[docs/pub-sub.md](https://github.com/redis/node-redis/blob/master/docs/pub-sub.md): "Using RESP2, Pub/Sub 'takes over' the connection (a client with subscriptions will not execute commands), therefore it requires a dedicated connection. You can easily get one by `.duplicate()`ing an existing `RedisClient`":

```js
const subscriber = client.duplicate();
subscriber.on('error', err => console.error(err));
await subscriber.connect();
```

"When working with either `RedisCluster` or `RedisSentinel`, this is handled automatically for you." `duplicate(overrides?)` builds a new client from the parent's options plus overrides ([`lib/client/index.ts`](https://github.com/redis/node-redis/blob/master/packages/client/lib/client/index.ts), `duplicate`): nothing is shared at the socket level, so the duplicate reconnects on its own schedule and needs its own `error` listener — the rule that a client without one crashes the process applies to it (the cache handler notes the same in [client.ts](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/src/client.ts)).

RESP3 is the v6 default ([v5-to-v6](https://github.com/redis/node-redis/blob/master/docs/v5-to-v6.md)). Under RESP3 node-redis delivers Pub/Sub through the push handler rather than by hijacking `onReply` (`lib/client/commands-queue.ts` `#setupPubSubHandler`: "RESP3 uses `onPush` to handle PubSub, so no need to modify `onReply`"), and nothing client-side refuses ordinary commands while subscribed. The docs still only describe the `duplicate()` path, and a shared connection would fall under the `pubsub` output-buffer class (§1.1), so the dedicated connection stays the right design regardless of protocol. Re-authentication is "not supported on RESP2 with PubSub active" (`lib/client/index.ts`, `#handshake` guard).

The same reasoning applies to a blocking `XREAD`: a command blocked on the socket stalls everything pipelined behind it, so a stream reader also lives on a `duplicate()`.

### 2.2 Across disconnect/reconnect

On every new socket, before the client becomes `ready`, node-redis re-issues the subscriptions (`lib/client/index.ts` `#initiateSocket` → `this.#queue.resubscribe(chainId)`; `lib/client/pub-sub.ts` `resubscribe()` emits one `SUBSCRIBE ch1 ch2…` / `PSUBSCRIBE …` per type and one `SSUBSCRIBE ch` per sharded channel). The `should resubscribe` test in [`index.spec.ts`](https://github.com/redis/node-redis/blob/master/packages/client/lib/client/index.spec.ts) kills the subscriber with `CLIENT KILL`, awaits `ready`, publishes, and expects both the channel and the pattern listener to fire. A `MOVED` reply during resubscribe drops all listeners and emits `__MOVED` for the cluster layer to re-place them.

What this does not do: recover anything published between the socket dying and `ready`. The sibling's probe ([node-redis-capabilities.md §6](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/docs/research/node-redis-capabilities.md)) gives the event order: `error` → `reconnecting` → (`connect` → `ready`) with the default backoff `min(2^retries·50, 2000) + jitter(0–200)` ms ([`lib/client/socket.ts`](https://github.com/redis/node-redis/blob/master/packages/client/lib/client/socket.ts) `defaultReconnectStrategy`), which "By default, do not reconnect on socket timeout" — returns `false` for `SocketTimeoutError`, closing the client for good. A long-lived subscriber must therefore pass its own `reconnectStrategy` (the cache handler's `reconnectDelay` never returns `false`).

`pingInterval` keeps working on a subscriber: `#setPingTimer` sends `PING` whenever the socket is ready (`lib/client/index.ts`), and `PING` is one of the commands allowed in RESP2 subscribed mode. On a connection blocked in `XREAD BLOCK`, the `PING` queues behind the read and only answers when the read returns, so `BLOCK` must stay comfortably below `socketTimeout` (the idle timer: "The maximum duration… that the socket can remain idle (i.e., with no data sent or received) before being automatically closed", [client-configuration](https://github.com/redis/node-redis/blob/master/docs/client-configuration.md)).

Offline queue ([FAQ](https://github.com/redis/node-redis/blob/master/docs/FAQ.md)): commands in flight when the socket closes are rejected; queued ones wait for the new socket unless `disableOfflineQueue: true`, in which case they reject with `ClientOfflineError`. For the Publish path this is the cache handler's choice: fail fast, let the caller decide.

Cluster (`lib/cluster/cluster-slots.ts`): the classic Pub/Sub connection is one client on a random node (`#initiatePubSubClient`); when that node leaves the topology its listeners are moved to a new random node (`RESUBSCRIBE_LISTENERS_EVENT`). Sharded: one Pub/Sub client per master (`getShardedPubSubClient(channel)` → `slots[calculateSlot(channel)].master`); `sharded-channel-moved` triggers `rediscover` and re-subscription on the new owner; `SSUBSCRIBE` retries `MOVED` up to `maxCommandRedirections` (default 16, `lib/cluster/index.ts`). `minimizeConnections: true` is offered "for short-term or Pub/Sub-only connections" ([clustering.md](https://github.com/redis/node-redis/blob/master/docs/clustering.md)).

### 2.3 Stream commands in v6

Typed signatures ([`lib/commands/`](https://github.com/redis/node-redis/tree/master/packages/client/lib/commands)):

- `xAdd(key, id, message, { TRIM: { strategy: 'MAXLEN' | 'MINID', strategyModifier: '~', threshold: number, limit? } })` — `threshold` is typed `number`, which for `MINID` means passing the millisecond part only (valid: an incomplete ID is `<ms>-0`). `xTrim(key, strategy, threshold: number | string, { strategyModifier, LIMIT })` accepts a full ID string.
- `xRange(key, start, end, { COUNT })` — start/end are raw arguments, so `'(1724400000000-3'` and `'+'` pass through.
- `xRead({ key, id } | [...], { COUNT, BLOCK, MAXCOUNT?, MAXSIZE? })` — RESP3 reply "normalized to v4/v5-compatible stream list shape" ([v5-to-v6](https://github.com/redis/node-redis/blob/master/docs/v5-to-v6.md)); message objects are plain objects in v6.
- `commandOptions.timeout` (v6 default 5000 ms) "applies to commands that haven't been written to the socket yet" ([command-options.md](https://github.com/redis/node-redis/blob/master/docs/command-options.md)), so it does not abort a blocking `XREAD` already on the wire — the blocking wait is bounded by `BLOCK` itself.

## 3. Cluster mode

[Cluster spec](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/): `HASH_SLOT = CRC16(key) mod 16384`; hash tags: "If the key contains a '{...}' pattern only the substring between `{` and `}` is hashed" — precisely, the substring between the first `{` and the first following `}`, if non-empty. `{user1000}.following` and `{user1000}.followers` share a slot; `foo{}{bar}` hashes whole. Since 8.0, `SCAN 0 MATCH {abc}*` is slot-optimised.

Pub/Sub in a cluster: "clients can subscribe to every node, and can also publish to every other node. The cluster will make sure that published messages are forwarded as needed… It will simply broadcast each published message to all other nodes" (cluster spec). Sharded: "shard channels are assigned to slots with the same algorithm Redis uses to assign keys to slots… It restricts the propagation of messages to be within the shard of a cluster. Hence, the amount of data passing through the cluster bus is limited" ([pubsub](https://redis.io/docs/latest/develop/pubsub/#sharded-pubsub)); `SSUBSCRIBE` "can also return a -MOVED redirect" and "All shard channels in a single SSUBSCRIBE call must belong to the same slot" ([SSUBSCRIBE](https://redis.io/docs/latest/commands/ssubscribe/)). Valkey 8 adds a "lightweight cluster message header for Pub/Sub messages" ([8.0 notes](https://github.com/valkey-io/valkey/blob/8.0.0/00-RELEASENOTES)).

`SELECT` "cannot be used, since Redis Cluster only supports database zero" ([SELECT](https://redis.io/docs/latest/commands/select/)) on Redis and Valkey ≤ 8; Valkey 9.0 does "Add multi-database support to cluster mode" ([9.0 notes](https://github.com/valkey-io/valkey/blob/9.0.0/00-RELEASENOTES)). Either way Pub/Sub ignores the database (§1.1), so databases are not an isolation tool here — the cache handler's [ADR-0001](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/docs/adr/0001-key-layout.md) reached the same conclusion: "The prefix is the only isolation mechanism between apps sharing one Redis: Redis databases are not used… and never documented."

node-redis `keyPrefix` (v6) prefixes keys only: "Pub/Sub channels are not prefixed (this includes sharded SPUBLISH/SSUBSCRIBE), since channels are a separate namespace from keys" ([client-configuration](https://github.com/redis/node-redis/blob/master/docs/client-configuration.md#key-prefixing)); in cluster mode "the slot is computed from the prefixed key". It is an ioredis-compatibility convenience, not something the library should rely on: the Prefix must be applied by the Transport itself so channels and keys agree, and so a consumer's own `keyPrefix` on an injected client does not double-prefix.

Implication: an App's stream key is one key, hence one slot, hence one master — every Instance's reader connects to that master. Replicas serve `XREAD` only with `READONLY`, which node-redis exposes through `isReadonly` routing (`lib/cluster/cluster-slots.ts` `getClientForKey`); **unsourced** whether reading the replay from a replica is ever worth the replication lag. That is the same blast radius as sharded Pub/Sub and is fine for v0.1.

## 4. Valkey 8 compatibility and differences

From the [migration guide](https://valkey.io/topics/migration/) and the [8.0 release notes](https://github.com/valkey-io/valkey/blob/8.0.0/00-RELEASENOTES):

- "Valkey 8.0.0 GA — Released Sun 15 Sep 2024… This release is fully compatible with Redis OSS 7.2.4." "Valkey 7.2.4 is a fork of Redis OSS 7.2.4."
- "Protocol: Valkey uses the RESP wire protocol and supports both RESP2 and RESP3. Existing Redis client libraries can connect to Valkey without code changes."
- "INFO: Valkey reports `redis_version:7.2.4`… Use `server_name` and `valkey_version` to detect the actual Valkey server and version." The sibling's [redis-container.ts](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/tests/redis-container.ts) already detects families this way; reuse it.
- The stream/Pub/Sub feature set relevant here is the Redis 6.2/7.0 one: `NOMKSTREAM`, `MINID`, `LIMIT` are `"since": "6.2.0"` in [`src/commands/xadd.json@8.0.0`](https://github.com/valkey-io/valkey/blob/8.0.0/src/commands/xadd.json); sharded Pub/Sub "From Redis OSS 7.0" ([Valkey pubsub](https://valkey.io/topics/pubsub/)); `XINFO STREAM` has `max-deleted-entry-id`/`entries-added` ([Valkey XINFO](https://valkey.io/commands/xinfo-stream/)); `XREAD … +` added in 8.0.
- Not in Valkey (Redis-only, documented in [redis/docs](https://github.com/redis/docs) with "Available since Redis 8.x"): `KEEPREF|DELREF|ACKED` (8.2), `IDMP`/`IDMPAUTO` idempotent `XADD` (8.6), `XREAD MAXCOUNT`/`MAXSIZE` (8.10), pattern-slot `SCAN` optimisation (8.0). Valkey's `xadd.md` has zero mentions of `IDMP`/`KEEPREF`. node-redis `XAddOptions` types them as "added in 8.6"; sending them to Valkey would be a syntax error. Not needed.
- Licence: Valkey `COPYING` is "BSD 3-Clause License"; Redis 8.0.0 "License change: licensed under your choice of RSALv2, SSPLv1, or AGPLv3" ([8.0.0 notes](https://github.com/redis/redis/blob/8.0.0/00-RELEASENOTES)). Irrelevant to code, relevant to which image the docs recommend.
- Behaviour changes in 8.0 that could surface in tests: "Remove `Redis` from various error reply messages" (error-code prefixes like `WRONGTYPE`, `NOPERM` are unchanged — the cache handler's `REPLY_CODE` regex depends only on those); `client-output-buffer-limit pubsub 32mb 8mb 60` unchanged.
- Data files: "Redis CE 7.4 and later produce data files that are not compatible with Valkey" — only matters for operators migrating, not for the library.

## 5. A Prefix-safe naming scheme

Constraints established above: Pub/Sub is global across databases; `keyPrefix` skips channels; cluster slots are computed per key/shard-channel with the `{…}` rule; the cache handler already claims `next-cache:` verbatim and tags its manifest `{tags}`.

Proposal (Prefix is one App's namespace, default e.g. `next-sse:`; must contain no `{`/`}` so the hash tag below is the first brace pair):

| Thing | Name | Why |
|---|---|---|
| Replay stream (one per App) | `{<Prefix>}log` | one key, one slot; hash tag = whole Prefix |
| Pub/Sub channel (design C only) | `{<Prefix>}events` | same slot as the stream so `SPUBLISH` is legal in a `MULTI`/script that also `XADD`s; with classic `PUBLISH` the tag is harmless |
| Future per-Channel Redis keys/channels | `{<Prefix>}ch:<Channel>` | stays in the App's slot; a second App never collides because its Prefix differs |

Two Apps = two Prefixes; `PUBSUB CHANNELS {<Prefix>}*` / `PUBSUB SHARDCHANNELS` and `SCAN 0 MATCH {<Prefix>}*` (slot-optimised on Redis 8) list one App's footprint. Putting the Prefix inside the braces rather than after them (`next-sse:{log}`) is deliberate: it keeps every key and channel of one App in one slot, which is what lets a later per-Channel design use `MULTI` or Lua across them. The downside — one App never spreads over more than one master — is the cost model the map already accepted for v0.1.

The Prefix must be the only thing the library reads to find an App's data, never the DB index: document `REDIS_URL=redis://host/3` as "the keys go to db 3, the channel is still global", as the cache handler's docs do for `keyPrefix`.

## 6. Cost model: one Redis channel per App, every Instance receives everything

Let I = Instances, P = Publishes/s, S = bytes per Message.

- Redis CPU per Publish: O(N+M) with N = I subscribers on the App channel and M = pattern subscriptions anywhere on the server ([PUBLISH](https://redis.io/docs/latest/commands/publish/)) — so never use `PSUBSCRIBE` for this; patterns tax every publish on the server, including other Apps'.
- Network egress from Redis: I × S per Publish, P × I × S per second, regardless of how many Instances have a subscriber for the Message's Channel. In a cluster with classic `PUBLISH` add one cluster-bus copy per node; with `SPUBLISH` only the owning shard.
- Per Instance: parse every Message, route in-process to the Connections subscribed to its Channel. Messages whose Channel has no local subscriber are parsed and dropped; the waste is (1 − locality) of the total. With the stream design the same applies to `XREAD` batches, but batching (`COUNT`) amortises the round trips.
- Failure mode under load: a subscriber that cannot drain 8 MB for 60 s or 32 MB at once is disconnected by the server and loses the gap (§1.1). An `XREAD` reader is a normal client (`client-output-buffer-limit normal 0 0 0`), is never pushed to, and falls behind instead of losing — until it falls out of the `MAXLEN` window, which `XINFO`/first-entry detects.
- Memory: stream of `MAXLEN ~ N` entries per App; streams are "very memory efficient" macro-node radix trees ([streams intro](https://redis.io/docs/latest/develop/data-types/streams/#capped-streams)). **Unsourced**: bytes per entry for a given payload; measure with `MEMORY USAGE` in the testing ticket.

When this stops scaling, the map's "Per-Channel Redis subscriptions" item is the answer; the naming scheme in §5 leaves room for it.

## 7. Timeouts and failure posture the cache handler already uses

From [src/client.ts](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/src/client.ts), [options.ts](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/src/options.ts), [env.ts](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/src/env.ts), [deadline.ts](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/src/deadline.ts), [retry.ts](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/src/retry.ts):

```ts
createClient({
  url,
  disableOfflineQueue: true,
  pingInterval: 10_000,
  socket: {
    connectTimeout: 2_000,
    socketTimeout: 15_000,
    reconnectStrategy: (retries) => Math.min(50 * 2 ** retries, 2_000) + Math.random() * 200,
  },
});
```

- `reconnectStrategy` "never `false` nor an `Error`: node-redis reads either of those as 'give up'"; the default gives up on `SocketTimeoutError` (verified in `lib/client/socket.ts`).
- `socketTimeout` 15 s is the reply-side dead-connection detector ("covers the HELLO a proxy… accepts and never replies to"); it is an idle timer, so `pingInterval` 10 s keeps a healthy connection alive. For a subscriber/reader connection the same pair works (§2.2), with `XREAD BLOCK` ≤ ~5 s if design B is chosen, so that a blocked read never starves the `PING`.
- Lazy connect: "a process that never reads or writes an Entry must never open a socket" — `next build` workers load the module too. A Transport must likewise not connect until the first Publish or Connection.
- Mandatory `error` listener; `client.unref()` after connect so the client never holds the process open; `close()` destroys a connection attempt still in progress: "the reconnect strategy never gives up, so a shutdown during an outage would otherwise never return".
- Fail fast while down: `connected()` rejects at once with "the cache client is not connected" when the client is not ready and has already been seen failing, instead of waiting out a deadline; nothing is latched, the client comes back on its own.
- `withDeadline(ms, op)` around the whole awaited operation (default `operationTimeout` 1 s), because node-redis's per-command timeout and abort signal cover only commands not yet written (confirmed in [command-options.md](https://github.com/redis/node-redis/blob/master/docs/command-options.md) and the sibling's probe).
- `withRetries` with a total budget (default 5 s for `updateTags`), per-attempt deadline, 50 → 500 ms doubling backoff, and a closed list of retryable reply codes `LOADING BUSY MASTERDOWN READONLY NOREPLICAS CLUSTERDOWN TRYAGAIN MOVED ASK`; everything not shaped like a reply error (socket errors, `ClientOfflineError`) is retried; `WRONGTYPE`/`NOPERM`/`OOM`/`ERR` end the loop. Only idempotent operations go in — relevant because `XADD *` is **not** idempotent: a retried Publish after a timed-out attempt may append twice (Redis 8.6 `IDMP` solves exactly this but is absent on Valkey; client-side, a Message id field in the entry lets readers dedupe).
- Zero-config: `REDIS_URL` → `url`, unset/empty → no store; every other variable parsed before the URL is looked at; `keyPrefix` verbatim with default `next-cache:`; one `onError(error, operation)` hook (default `console.error`), `debug` flag. Reconnects are counted on `reconnecting` (standalone) / `node-reconnecting` (cluster) / `topology-change` (sentinel) to know when a cached read must be refreshed — the same signal a Transport would use to trigger "replay since my last ID" in design C.
- Client kinds are detected structurally (`nodeClient` in client → cluster, `_execute` → sentinel) so an injected client from another copy of node-redis works; a Transport accepting an injected client inherits that problem and that answer.
- Tests: testcontainers, default image `valkey/valkey:8`, floors `redis:6.2` and `valkey/valkey:7.2` in a matrix ([redis-container.ts](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/tests/redis-container.ts)).

## Recommendation for next-sse

1. **Buffer in a Stream, one per App, key `{<Prefix>}log`, trimmed by `XADD … MAXLEN ~ N` on every Publish** (plus an optional periodic `XTRIM MINID ~ <TIME − window>` if a time bound is wanted). The stream ID is the Connection's cursor and the SSE `id:`; `Last-Event-ID` brings it back on reconnect; the cursor at render time is the ID of the stream's last entry. Replay with `XRANGE key (cursor + COUNT n`; if the cursor is older than the first entry, refuse to resume and make the client refetch (a documented `resync` event), never silently skip.
2. **Fan out with one `XREAD BLOCK` reader per Instance (design B), not Pub/Sub**, on a `duplicate()`d connection with the cache handler's tuning and `BLOCK ≤ 5000`. It is one primitive, one write per Publish, totally ordered, and — unlike Pub/Sub — survives the Instance's own Redis reconnect without a gap, since the loop just reissues `XREAD` from its last ID. It also gives natural backpressure instead of server-side disconnection. Publish from the main client: `XADD` only; an external publisher's contract is then "XADD this key with these fields", which is the stable wire format the map asks for.
3. Keep Pub/Sub (design C) as the documented fallback if measured wake-up latency of `XREAD` is unacceptable; the naming scheme reserves `{<Prefix>}events` for it, and the Instance must then `XRANGE` from its last ID after every `reconnecting`.
4. Copy the cache handler's client module posture wholesale (§7) — same constants, same `reconnectStrategy`, `disableOfflineQueue`, lazy connect, `unref`, `withDeadline` on Publish, `onError` hook, structural client-kind detection — and its `serverVersion()` family detection for the test matrix. Do not extract shared code yet (map rule).
5. Use Redis 6.2/7.0 features only (`MINID`, `NOMKSTREAM`, sharded Pub/Sub if ever, `XINFO` 7.0 fields). Never `IDMP`, `KEEPREF`, `MAXCOUNT` or other 8.x-only options: Valkey 8 rejects them.
6. Prefix is the only isolation; put it inside the hash tag; reject Prefixes containing `{`/`}`; document that the DB index does not scope anything the library does.

## Open questions

1. Wake-up latency and throughput of `XREAD BLOCK` per Instance vs `PUBLISH` push, on Redis 8 and Valkey 8, under P ≈ 100–1000 Publishes/s with I = 2–8 — unmeasured; decides B vs C. Suggested probe: the sibling's appendix-style scripts, in the testing ticket.
2. Memory per stream entry for the expected Message shape (`MEMORY USAGE` after N entries) to pick a default `MAXLEN`.
3. Publish idempotency: a Publish whose `XADD` timed out after being written may be duplicated on retry. Accept at-least-once into the buffer and dedupe by a client-side Message id, or never retry Publish (fail to the caller as the cache handler's `get`/`set` do)?
4. Whether `XREAD` on a replica (`READONLY`) is ever useful for the readers, or whether all Instances reading from the slot master is fine for v0.1.
5. `commandOptions.timeout` defaults to 5 s in v6: set it to `undefined` on the reader client so a command queued behind a `BLOCK` wait is never aborted, or keep `BLOCK` under it? Needs a decision when the Transport is specified.
6. Sentinel: the cache handler supports it; whether the SSE Transport's reader must follow a failover (`topology-change`) by reissuing `XREAD` with its cursor — node-redis handles the connection, the loop handles the cursor, but this is untested.
7. Graceful shutdown of the reader (map's "Not yet specified"): `XREAD BLOCK` must be cut short on SIGTERM; `client.destroy()` does that, `close()` waits for the reply.
8. Whether the per-Instance reader should read more than one stream (`XREAD STREAMS k1 k2`) once per-Channel streams exist — a design seam to keep open in the Transport interface.

## Sources

node-redis (master, `@redis/client` 6.2.1):

- https://github.com/redis/node-redis/blob/master/docs/pub-sub.md
- https://github.com/redis/node-redis/blob/master/docs/client-configuration.md
- https://github.com/redis/node-redis/blob/master/docs/command-options.md
- https://github.com/redis/node-redis/blob/master/docs/FAQ.md
- https://github.com/redis/node-redis/blob/master/docs/clustering.md
- https://github.com/redis/node-redis/blob/master/docs/v5-to-v6.md
- https://github.com/redis/node-redis/blob/master/docs/RESP.md
- https://github.com/redis/node-redis/blob/master/packages/client/lib/client/index.ts (`#initiateSocket`, `duplicate`, `#setPingTimer`, `#handshake`)
- https://github.com/redis/node-redis/blob/master/packages/client/lib/client/pub-sub.ts (`resubscribe`)
- https://github.com/redis/node-redis/blob/master/packages/client/lib/client/commands-queue.ts (`#setupPubSubHandler`, `resubscribe`)
- https://github.com/redis/node-redis/blob/master/packages/client/lib/client/socket.ts (`defaultReconnectStrategy`, option docs)
- https://github.com/redis/node-redis/blob/master/packages/client/lib/client/index.spec.ts (`should resubscribe`)
- https://github.com/redis/node-redis/blob/master/packages/client/lib/cluster/index.ts (`SSUBSCRIBE`)
- https://github.com/redis/node-redis/blob/master/packages/client/lib/cluster/cluster-slots.ts (`#initiatePubSubClient`, `getShardedPubSubClient`, `getClientForKey`)
- https://github.com/redis/node-redis/tree/master/packages/client/lib/commands (`XADD.ts`, `XRANGE.ts`, `XREAD.ts`, `XTRIM.ts`, `XINFO_STREAM.ts`)
- https://github.com/redis/node-redis/releases

Redis:

- https://redis.io/docs/latest/develop/pubsub/
- https://redis.io/docs/latest/commands/publish/ · https://redis.io/docs/latest/commands/ssubscribe/ · https://redis.io/docs/latest/commands/select/
- https://redis.io/docs/latest/commands/xadd/ · https://redis.io/docs/latest/commands/xrange/ · https://redis.io/docs/latest/commands/xread/ · https://redis.io/docs/latest/commands/xtrim/ · https://redis.io/docs/latest/commands/xinfo-stream/
- https://redis.io/docs/latest/develop/data-types/streams/
- https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/
- https://github.com/redis/redis/blob/unstable/redis.conf (`client-output-buffer-limit`)
- https://github.com/redis/redis/blob/8.0.0/00-RELEASENOTES (licence)

Valkey:

- https://github.com/valkey-io/valkey/blob/8.0.0/00-RELEASENOTES
- https://github.com/valkey-io/valkey/blob/9.0.0/00-RELEASENOTES
- https://github.com/valkey-io/valkey/blob/8.0.0/valkey.conf
- https://github.com/valkey-io/valkey/blob/8.0.0/src/commands/xadd.json
- https://github.com/valkey-io/valkey/blob/main/COPYING
- https://valkey.io/topics/migration/ · https://valkey.io/topics/pubsub/ · https://valkey.io/commands/xinfo-stream/ · https://valkey.io/commands/xadd/
- https://github.com/valkey-io/valkey/releases

Sibling (`flolefebvre/nextjs-redis-cache-handler`, main):

- https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/src/client.ts
- https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/src/options.ts
- https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/src/env.ts
- https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/src/deadline.ts
- https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/src/retry.ts
- https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/docs/adr/0001-key-layout.md
- https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/docs/adr/0002-entry-write-time-on-redis-clock.md
- https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/docs/research/node-redis-capabilities.md
- https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/tests/redis-container.ts
- https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/package.json

SSE:

- https://html.spec.whatwg.org/multipage/server-sent-events.html (`Last-Event-ID`, `id`, `retry`)
