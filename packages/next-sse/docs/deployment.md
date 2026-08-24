# Deployment

Self-hosted Node behind a proxy is the target this library is built for: one or many Instances,
a load balancer in front, Redis or Valkey behind. This page is the checklist.

## What the response already carries

The handler sets these on every stream, so a proxy has everything it needs to do the right thing:

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

## Proxy checklist

- [ ] **Response buffering off.** A proxy that collects the response before forwarding it turns a
      live stream into a page that never arrives. This is the single most common reason an SSE app
      appears to hang.
- [ ] **No compression, no transformation** of `text/event-stream`. `no-transform` says so; a
      proxy configured to gzip everything regardless will still buffer.
- [ ] **Read/idle timeouts above the heartbeat interval**, or off. The default heartbeat is 15 s,
      so a 60 s idle timeout is comfortable; a 10 s one cuts healthy Connections.
- [ ] **HTTP/1.1 or HTTP/2 to the upstream, kept alive.** Both work. Over HTTP/1.1 a browser
      allows six connections per origin and each open page holds one of them for its stream;
      HTTP/2 removes that ceiling, so it is worth having on the client-facing side.
- [ ] **No sticky sessions needed.** A Connection carries its own Cursor, so any Instance can
      serve its reconnect. Round-robin is fine and is what spreads Connections after a deploy.
- [ ] **Health checks that take a `503` seriously**: a draining Instance answers new connects with
      `503` and `Retry-After`, which is exactly the signal to stop sending it traffic.

### nginx

```nginx
location /api/sse {
    proxy_pass http://app;
    proxy_http_version 1.1;
    proxy_set_header Connection "";

    proxy_buffering off;
    proxy_cache off;
    gzip off;

    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}
```

### Caddy

```caddyfile
:8080 {
	reverse_proxy app-a:3000 app-b:3000 {
		lb_policy round_robin
		flush_interval -1

		lb_try_duration 5s
		fail_duration 10s
	}
}
```

Caddy already streams `text/event-stream` as it arrives; `flush_interval -1` states it. The
`lb_try_duration`/`fail_duration` pair is what takes a stopped Instance out of rotation during a
redeploy.

### A runnable reference

Two Instances, one Valkey, Caddy in front, on one screen:
[`examples/basic/compose.yaml`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/compose.yaml)
with its [`Caddyfile`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/Caddyfile).
Bring it up, open two tabs, publish in one, then stop a container and watch the other tab carry
on.

## Running more than one Instance

Set `REDIS_URL` and the Instances become one App. That is the whole of it: no sticky sessions, no
shared memory, no coordination.

- Every Instance reads the **entire** log and delivers to the Connections it holds. An Entry for a
  Channel nobody local is subscribed to is dropped for free.
- A Publish from any Instance — or from a worker outside Next.js — reaches every Connection.
- A Kick from any Instance reaches every Instance.
- A client that lands on another Instance after a reconnect resumes from its Cursor, so nothing is
  lost or repeated.
- **The Prefix is the only isolation.** Two Apps sharing a server under the default `next-sse`
  Prefix deliver each other's Messages. Set `NEXT_SSE_PREFIX` per App.

## Environment

| Variable                     | Default    | What it does                                               |
| ---------------------------- | ---------- | ---------------------------------------------------------- |
| `REDIS_URL`                  | unset      | Set → the Redis Transport. Unset → the Memory Transport    |
| `NEXT_SSE_PREFIX`            | `next-sse` | The per-App namespace, and the only isolation between Apps |
| `NEXT_SSE_RETENTION_WINDOW`  | `300`      | How long an Entry stays replayable, in seconds             |
| `NEXT_SSE_RETENTION_CAP`     | `10000`    | How many Entries the log keeps at most                     |
| `NEXT_SSE_OPERATION_TIMEOUT` | `1000`     | How long one Transport operation may take, in milliseconds |
| `NEXT_SSE_DEBUG`             | `false`    | Narrate what the Transport's reader is doing               |

The retention names carry no `REDIS` because they bind both shipped Transports. An unset or empty
variable configures nothing; anything passed to a factory in code wins over the environment.

**Sizing retention.** The window is how long a client may be away and still resume without a
Reset — laptop sleep, a tunnel, a redeploy. 300 s covers all three comfortably. The cap bounds
memory on the log: at 10 000 Entries a burst above that rate trims the window short, and clients
that were away hit a Reset instead of a replay. Raise the cap for a chatty App before raising the
window.

## Redeploys, SIGTERM and Drain

The library installs `SIGTERM`/`SIGINT` handlers by default. On a signal, this Instance:

1. **refuses new connects** with `503` and `Retry-After`, so the load balancer moves clients on;
2. **ends every open Connection** with `reconnect`, each on its own draw inside the drain window
   (default 3000 ms) so the whole table does not come back at once;
3. **closes the Transport last**, after the last Connection is gone.

Clients reconnect to a surviving Instance and resume from their Cursor. Nothing is lost. Node runs
every listener for a signal, so these coexist with Next.js's own — and the Drain ending the SSE
responses is exactly what lets Next's `server.close()` resolve. **`NEXT_MANUAL_SIG_HANDLE` is
never needed.** A draining Instance also closes the connection it refuses on, so a client
connected straight to the pod cannot hold the process open through its termination grace: the
exit is prompt whether or not there is a proxy in between.

**The orchestrator's grace period must exceed the drain window.** Otherwise the process is killed
mid-Drain and the remaining clients see a broken pipe instead of a `reconnect` — they still
recover, from their Cursors, but through a retry rather than a clean handoff.

| Where                                      | Default grace | With a 3 s drain window              |
| ------------------------------------------ | ------------- | ------------------------------------ |
| Kubernetes `terminationGracePeriodSeconds` | 30 s          | fine as-is                           |
| Traefik `graceTimeOut`                     | 10 s          | fine; shorten the window before this |
| Caddy                                      | waits         | fine as-is                           |
| Bare `docker stop`                         | 10 s          | fine as-is                           |

Tune it on `initSSE`:

```ts
initSSE({ drain: 5000 }); // a wider window: gentler on the survivors
initSSE({ drain: 0 }); // end every Connection at once, still cleanly
initSSE({ drain: false }); // install no handlers; sequence the shutdown yourself
```

`drain: false` is the only value that removes the handlers. A custom server then calls
`await sse.drain()` itself — idempotent, and it resolves when the Connections are closed and the
Transport is shut.

### Restarting on the Memory Transport

A single-Instance App on the Memory Transport loses its log when the process goes. Its Cursors
carry a per-process epoch, so every returning client is answered `gone`, which becomes a Reset:
`router.refresh()` re-mints Snapshots and the pages are whole again. It costs no App code and no
configuration — it is the same machinery that covers a trimmed log — but it is a refetch for
every open page at once, which is a reason to move to Redis or Valkey before a redeploy is a busy
moment.

## Connection lifetime

Every Connection is ended and reopened after 30 minutes ±10 % by default (`maxLifetime`), through
the same gap-free `reconnect` path as a Kick or a Drain. It re-spreads Connections across
Instances after a deploy, and reclaims the ones a proxy dropped without telling anyone. Set `0` to
disable it.

The heartbeat (`heartbeat`, default 15 s) is what keeps proxies from idling a quiet Connection out
and what the client's watchdog watches: three intervals with no bytes at all and it reconnects.
Lower it if something in the path idles out faster than 45 s.

## Vercel and other serverless platforms

> **Caveat.** This library is designed for a long-lived Node process. Serverless platforms cap how
> long a response may stream, and every Instance is short-lived by construction. On Vercel, a
> route handler's maximum duration bounds every Connection: it ends when the function's budget
> runs out, on the plan's ceiling, not on `maxLifetime`. The client reconnects from its Cursor and
> nothing is lost, so an App does work there — at the cost of a reconnect per budget window per
> client, and one function invocation held open for the whole of it.
>
> If you deploy there: set `REDIS_URL` (there is no shared memory between invocations, so the
> Memory Transport cannot fan out), set `maxLifetime` below the platform's cap so the cut is the
> library's clean one, and expect the SIGTERM Drain not to apply — the platform's lifecycle is
> not a signal you receive. Self-hosted Node remains the supported target.

## Debugging a deployment

| Symptom                                   | First thing to check                                                |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Page never leaves `connecting`            | proxy buffering; `curl -N` the route directly against an Instance   |
| Connection drops every N seconds, N < 60  | a proxy idle timeout below the heartbeat interval                   |
| Messages arrive on some tabs only         | two Apps sharing a Prefix, or one Instance without `REDIS_URL`      |
| Every client Resets after a deploy        | the Memory Transport, or a retention window shorter than the deploy |
| `503` with `Retry-After` on every connect | the Transport is unreachable, or the Instance is draining           |
| The process does not exit on `SIGTERM`    | `drain: false` with nothing calling `sse.drain()`                   |

`NEXT_SSE_DEBUG=1` makes the Transport's reader narrate what it is doing.
