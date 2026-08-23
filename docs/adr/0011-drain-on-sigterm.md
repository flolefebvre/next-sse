# Drain: the Instance ends its own Connections on SIGTERM

`next start` handles `SIGTERM`/`SIGINT` by awaiting `server.close()`, which never closes active responses, so a process with open Connections hangs until the orchestrator's `SIGKILL` and every client sees a dead socket. **The library installs its own `SIGTERM`/`SIGINT` listeners by default**, once per process via the `globalThis` Instance slot, on Instance start. Node runs every listener, so Next's handlers stay in place and the two are self-synchronizing: the Drain ending the SSE responses is exactly what lets Next's `server.close()` resolve and its exit proceed. `NEXT_MANUAL_SIG_HANDLE` is never needed and the docs say so.

**The Drain sequence is: refuse, spread, close.** The Instance marks itself draining and the SSE route answers new connects with `503` + `Retry-After` (the ADR-0004 pre-Authorize path); accepting them would strand a client for a second cut inside the grace window. Existing Connections end with the `reconnect` Control event and a close — the Kick/max-lifetime path, so the client core reconnects at once with its Cursor and loses nothing — spread with full jitter over the drain window so one Instance's whole Connection table does not re-Authorize and replay against the survivors in the same instant. `transport.close()` runs last, after the Connections are gone: Publishes during the window succeed (in-flight server actions still land in the log, and the kicked clients replay them from a survivor — that is what gap-free means), then reject `TransportClosedError` (ADR-0005). Drain is Instance-local and writes nothing to the Transport log.

**Config is `drain?: number | false` on `initSSE`** (amends ADR-0008): the number is the jitter window in ms, default `3000`; `false` skips installing signal handlers; `0` installs them and closes everything immediately. Deliberately asymmetric with `maxLifetime: 0` (which disables the feature): `0` is a legitimate window value here, so disabling installation is `false`.

**`sse.drain(): Promise<void>` is public and idempotent**: it resolves once every Connection is closed and the Transport close has settled, and repeated calls — including a second signal mid-Drain — return the same in-flight promise. Custom servers and tests sequence their own shutdown on it; the signal handler just calls it. `drain` therefore joins the reserved Registry keys (`handlers`, `channels`, `snapshot`, `kick`), enforced at type level and runtime (amends ADR-0008).

**A Memory-Transport restart is a documented Reset-on-redeploy, no code.** Single Instance means the restart is downtime and the log dies with the process; reconnecting clients present a Cursor the new process's Transport does not know, get `gone` → `reset`, and the App refetches (provider-default `router.refresh()`). Single-Instance deployments cannot be gap-free across a restart by construction; the existing machinery already degrades exactly right.

**Deployment docs** state that orchestrator grace must exceed the drain window (Kubernetes defaults to 30 s; Traefik's `graceTimeOut` cuts everything at 10 s; Caddy waits forever), and carry the Memory-Transport restart story. A readiness/"draining" health signal is deferred to the observability-hooks fog.

## Considered Options

- Documentation-only (wire `process.on('SIGTERM')` yourself, or set `NEXT_MANUAL_SIG_HANDLE`): rejected, a library whose premise is long-lived Connections would hang every rolling deploy until `SIGKILL` out of the box, and manual signal handling is unavailable in `next dev`.
- Explicit `sse.drain()` only, wired from `instrumentation.ts`: rejected, breaks the zero-config posture for the deployment path every self-hosted App has; the default handler coexists safely with Next's.
- Close all Connections at once: rejected, a thundering herd of Authorize + replay from one Instance's whole table against the survivors.
- Drain as a control entry through the Transport (the Kick mechanism): rejected, Drain is Instance-local by definition and the log would broadcast it to every Instance.
- Keep serving new connects while draining: rejected, the LB may still route here and the client would be cut a second time inside the grace window.
- `drain: 0` to disable, matching `maxLifetime`: rejected, `0` is a real window value (immediate close); `false` is unambiguous.
- An object config (`drain: { window }`): rejected until a second knob exists.
- A 'draining' readiness endpoint or hook in v0.1: deferred to the observability-hooks fog (`onDrain` can join `onEvent`/`onError` if that ticket graduates).
