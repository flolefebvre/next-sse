# Redis Transport: one Stream per App, read by one blocking reader per Instance, carrying a versioned Entry envelope

The Redis Transport is one Redis Stream per App, key `{<Prefix>}:log`, and nothing else. `publish` is one `XADD {<Prefix>}:log MAXLEN ~ <retentionCap> * entry <json>`; the Cursor it returns is the stream entry ID (`<ms>-<seq>`, minted on the Redis clock). `read(after)` is `XRANGE {<Prefix>}:log (after + COUNT n`; `tail()` is `XINFO STREAM last-generated-id`, which survives the stream going empty. Every Instance's subscription is a single `XREAD BLOCK 5000 STREAMS {<Prefix>}:log <last-seen>` loop on a `duplicate()`d connection with the per-command timeout disabled, so a blocked read never starves `PING` and is never aborted. Pub/Sub is not used: it is at-most-once, so it would need the stream anyway for replay, and `XREAD BLOCK` wakes blocked readers on `XADD` with the same one-round-trip latency while surviving the Instance's own Redis reconnect without a gap (the loop reissues `XREAD` from its last ID).

**The Prefix is the only isolation, and it sits inside the hash tag.** Pub/Sub and Streams ignore the database index for the purposes that matter here and node-redis's `keyPrefix` never touches channel names, so the library applies the Prefix itself. `{<Prefix>}:` keeps every key an App will ever own in one cluster slot, which is what lets a later per-Channel design use `MULTI` or Lua across them; the cost, one App never spreading over more than one master, is the v0.1 cost model. A Prefix must be non-empty and contain no `{`, `}`, whitespace or control characters; it is otherwise verbatim. The default is `next-sse`, not derived from the App (nothing at runtime names it reliably): two Apps sharing one Redis under the same Prefix _cross-deliver_ (App A's `chat:42` reaches App B's subscribers of `chat:42`), which the docs state as the reason to set `NEXT_SSE_PREFIX` per App. The database index in `REDIS_URL` is documented as scoping nothing.

**One stream field, `entry`, holding the Entry as JSON; the version lives inside the JSON.** ADR-0005 wants the Transport to round-trip an Entry without knowing its shape, so that a new control kind touches no Transport; flat stream fields would couple the Redis Transport to the union. The JSON is the stable contract an external publisher writes in any language:

```json
{ "v": 1, "type": "message", "channel": "chat:42", "event": "message", "payload": { } }
{ "v": 1, "type": "control", "control": "kick", "key": "user-7" }
{ "v": 1, "type": "control", "control": "kick", "channel": "chat:42" }
```

Both `message` and `control` are documented (an admin service outside Next.js revoking access is a real Kick). Additions within `v: 1` are additive; `v: 2` only for a breaking change. The Memory Transport stores the same object. An event's Standard Schema _Output_ is bounded to `JsonValue` at `channel({ events })` time, so `payload` is what the client receives, typed honestly by construction (`z.date()` is a type error; `z.iso.datetime()` is the fix); no runtime check on the publish path, the bound covers it. On the read path the Instance validates nothing: an unparseable Entry or an unknown `v`, `type` or `control` is skipped and reported once through `onError`; a payload that does not match the schema is delivered as is, external publishers are responsible for it; an Entry whose Channel has no subscriber on this Instance is dropped for free (no Registry lookup, no log: during a rolling deploy, old Instances legitimately see Channels they do not know), logged only under `debug`.

**Retention is a count cap trimmed on every Publish and a time window trimmed by the readers.** `MAXLEN ~ <retentionCap>` rides on every `XADD` (external publishers are told to include it; the Instances trim regardless). There is no time-based stream primitive, so each Instance's reader loop issues `XTRIM {<Prefix>}:log MINID ~ <TIME − retentionWindow>` about once a minute, against the Redis clock; concurrent trims from several Instances are harmless, and the effective window is `retentionWindow` plus up to one trim interval. Enforcing the window at read time only was rejected: it would make `gone` depend on the Instance clock and leave big payloads resident in a quiet App. The Memory Transport applies the same two bounds in process.

**`gone` is exact: `after < max-deleted-entry-id`.** `XINFO STREAM` reports the highest ID ever deleted (Redis 7.0, present on Valkey 8), so a Cursor at or above it has lost nothing to trimming, whatever `~` did, and a Cursor below it has. A Cursor the Transport cannot parse is `gone` too, so the route answers `200` + `reset` rather than `400`: the Cursor is opaque to the Instance and the client core retries a non-200 with the same URL forever. Known hazard, accepted and documented: deleting the stream key (or `FLUSHALL`) resets `max-deleted-entry-id`, after which an old Cursor resumes as if nothing was missed; operators must not delete the stream while Instances run.

**Client posture and configuration mirror the cache handler.** `connectTimeout` 2 s, `socketTimeout` 15 s, `pingInterval` 10 s, `disableOfflineQueue`, a `reconnectStrategy` that never gives up, lazy connect, `unref()`, a mandatory `error` listener, `withDeadline(operationTimeout)` around `publish`/`read`/`tail`, one `onError(error, operation)` hook; an injected node-redis `client` (standalone, cluster or sentinel, detected structurally) is accepted and `duplicate()`d for the reader. The environment table, parsed in full before `REDIS_URL` is read, unset or empty meaning not given:

| Variable                     | Option                      | Default                 |
| ---------------------------- | --------------------------- | ----------------------- |
| `REDIS_URL`                  | `url`                       | none → Memory Transport |
| `NEXT_SSE_PREFIX`            | `prefix`                    | `next-sse`              |
| `NEXT_SSE_RETENTION_WINDOW`  | `retentionWindow` (seconds) | `300`                   |
| `NEXT_SSE_RETENTION_CAP`     | `retentionCap` (entries)    | `10000`                 |
| `NEXT_SSE_OPERATION_TIMEOUT` | `operationTimeout` (ms)     | `1000`                  |
| `NEXT_SSE_DEBUG`             | `debug`                     | `false`                 |

Retention applies to both Transports, so those names carry no `REDIS`. Only Redis 6.2/7.0 features are used (`MAXLEN ~`, `MINID ~`, `XINFO STREAM` 7.0 fields, `XRANGE (`); nothing Redis 8.x-only, so Valkey 8 is a first-class target.

## Considered Options

- Pub/Sub for wake-up plus the stream for replay: rejected, two primitives and a replay after every subscriber reconnect for a latency `XREAD BLOCK` already matches; `{<Prefix>}:events` is no longer reserved.
- Prefix derived from the package or App name: rejected, `npm_package_name` exists only under `npm run`, and a `cwd` hash changes with the deploy path.
- No default Prefix when `REDIS_URL` is set: rejected, breaks zero-config for the single-App majority to protect the minority the docs can warn.
- Prefix after the hash tag (`next-sse:{log}`): rejected, scatters an App's future keys across slots.
- Flat stream fields (`type`, `channel`, `event`, `payload`): rejected, readable in `redis-cli` but couples the Transport to the Entry union.
- Version as a separate stream field: rejected, the framing is one field; versioning the library-owned JSON is enough for third-party Transports too.
- `JSON.stringify` semantics for payloads (Dates become strings, `undefined` vanishes): rejected, client types would lie.
- Validating incoming payloads against the schema on every Instance: rejected for v0.1, a schema run per Message per Instance for a publisher that already validated.
- Reporting unknown Channels through `onError`: rejected, spams every old Instance for the length of a rolling deploy.
- Window enforced at read time only: rejected, `gone` would depend on clock skew and memory on the cap alone.
- `MINID` on every `XADD` (needs `TIME` first, two round trips or a script): rejected, the cap is what must hold per Publish; the window can lag a minute.
- `gone` from `first-entry` comparison: rejected, approximate trimming makes it lie in both directions; `max-deleted-entry-id` is exact.
- A companion epoch key folded into the Cursor to detect a recreated stream: rejected for v0.1, a second key on every read path for an operator error the docs can name.
- `400` for a malformed Cursor (ADR-0004): superseded, the core would retry it forever.
