# Connection lifecycle: heartbeat as a Control event, Transport outages hold Connections open

A Connection is one `GET` on the SSE route (`?channel=` repeated, optional `?cursor=`, `Last-Event-ID` wins). The handler bails out of prerendering, runs Authorize, and writes a `ready` Control event `{ cursor, heartbeat, refused }` as the first chunk of a `200` stream, followed by `retry: 3000`, the replay, `caught-up`, then the live feed. Only failures before Authorize answer non-200: `400` for no Channels or a malformed Cursor, `503` + `Retry-After` when the Transport is unavailable.

**Heartbeat is a named Control event (`heartbeat`, no `id:`), not an SSE comment.** Comments keep proxies alive but are invisible to JavaScript, so the client core could never detect a dead pipe (proxy idle-out, the iOS "stuck OPEN" report). A data-less `id:` block is mishandled by Firefox and WebKit, so the heartbeat carries none and never moves the Cursor. Default 15 s, configurable; the interval travels in `ready` and the core's watchdog reconnects after 3× without bytes.

**Max Connection lifetime is 30 min ±10 % by default (`0` disables)** and ends with the `reconnect` Control event and a close, the same path as Kick and, later, graceful shutdown; the core reconnects at once with its Cursor, so the cut is gap-free. The lifetime re-spreads Connections across Instances after a deploy and bounds Connections a proxy silently dropped.

**A Transport outage mid-Connection keeps every Connection open**, heartbeating, with no bound; when the Transport recovers the Instance resumes from its last seen position and sends `Reset` only if that position is gone. Closing would turn a backend blip into a thundering herd against Instances that are equally cut off. Operators learn about the outage through observability hooks, not through the wire.

**A live-only connect adopts the log's tail as its Cursor.** The handler reads the tail (Redis `XREVRANGE … COUNT 1`, Memory: last minted position; `0-0` when empty), a read that writes nothing, sends it in `ready`, and the core stores it as `lastEventId`. Without it a client that never received a Message would reconnect live-only after `reconnect` and could miss a Message published in the reconnect window. Native browser reconnects on such a client stay live-only (the browser's own `lastEventId` is empty): a 3 s window on a Channel that was quiet for the whole Connection, accepted for v0.1.

**Instance state lives on a `globalThis` symbol, always.** Turbopack HMR re-evaluates the route module per request after an edit, which would split the Memory Transport and the Connection table between module instances so a Publish from the new one never reaches Connections held by the old one. A `Symbol.for('@flefebvre/next-sse')` slot costs nothing in production and also makes `instrumentation.ts` and `route.ts` share one Instance; a re-evaluated `createSSE` swaps the Registry and reuses the Transport and Connection table.

**Client core.** Native `EventSource` reconnect handles transient drops (unthrottled timer, `Last-Event-ID` for free); the core owns non-200 responses (exponential 1 s → 30 s with full jitter, forever, `'reconnecting'` status, a visibility-to-visible transition short-circuits the timer), `reconnect`, watchdog expiry and Channel-set changes, each a new `EventSource` with the Cursor in the URL. It closes on `pagehide`/`freeze` only (not on every tab switch) and reconnects on `pageshow`/`resume`. Channel-set changes are coalesced on one macrotask tick, so many hooks mounting in one render open one Connection and React Strict Mode's setup → cleanup → setup burst collapses to one connect, with no development-only branch.

## Considered Options

- Comment heartbeat (`: ping`): rejected, invisible to the client, no liveness watchdog possible.
- Heartbeat with an `id:` to keep the Cursor fresh: rejected, Firefox drops and WebKit defers the `id` of a data-less block.
- No max lifetime by default: rejected, Connections never re-balance after a deploy and zombies a proxy dropped silently are never reclaimed; the cost is one gap-free reconnect per half hour.
- Authorize after flushing headers (first comment, then Authorize, then in-band result): rejected, two code paths for one outcome; Authorize is a session read, well under any proxy header timeout.
- Transport unavailable at connect: a held `200` stream until recovery: rejected, registers Connections the Transport cannot serve and hides the outage from load balancers.
- Transport lost mid-Connection: close all (native reconnect → `503` → backoff) or bound the hold to the retention window: rejected, churn for no benefit; retention is a Transport property the lifecycle should not assume.
- `globalThis` state in development only: rejected, a `NODE_ENV` branch for a slot that is free in production.
- Core owning every reconnect (close on any `error`, reopen itself): rejected, loses the unthrottled native timer in background tabs and the free `Last-Event-ID`.
- Give up after N fatal retries: rejected, the library's own non-200s are `400` (a bug, harmless to retry) and `503` (will recover); silent surrender is worse than a slow retry.
- Close on `visibilitychange → hidden`: rejected, a reconnect plus replay on every tab switch; the watchdog already catches a pipe that died while hidden.
