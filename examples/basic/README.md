# next-sse example app

The runnable counterpart of the documentation: every pattern the manual shows exists here as an
ordinary feature of a small Next.js app, and the e2e suite drives those same features. There is
no test-only route and no env-gated path — what a test exercises is what a reader copies.

## Run it

One Instance, no backend, on the Memory Transport:

```sh
pnpm --filter @flefebvre/next-sse run build
pnpm --filter next-sse-example-basic run dev
```

Then open <http://localhost:3000>. The page shows a room, the broadcast, this reader's own
notifications and an admin panel most readers are refused.

## The ten patterns, and where each one lives

| Pattern                          | Where                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-user notifications           | [`app/notifications.tsx`](app/notifications.tsx), `notifications` in [`lib/sse.ts`](lib/sse.ts), `notifyMe` in [`app/actions.ts`](app/actions.ts)            |
| Per-entity updates               | [`app/messages.tsx`](app/messages.tsx), `chat` in [`lib/sse.ts`](lib/sse.ts), [`app/api/webhook/route.ts`](app/api/webhook/route.ts)                         |
| Broadcast                        | [`app/announcements.tsx`](app/announcements.tsx), `announcements` in [`lib/sse.ts`](lib/sse.ts)                                                              |
| Server component + live takeover | [`app/page.tsx`](app/page.tsx) (`sse.snapshot`) into `useChannelState`                                                                                       |
| Optimistic sends                 | `act(...)` in [`app/messages.tsx`](app/messages.tsx), `send` in [`app/actions.ts`](app/actions.ts)                                                           |
| Publishing from a worker         | [`worker/publish.ts`](worker/publish.ts) (typed, no Next.js) and [`worker/raw-envelope.ts`](worker/raw-envelope.ts) (the `{ v: 1, … }` envelope, no library) |
| Kick                             | [`app/api/kick/route.ts`](app/api/kick/route.ts), `kickMe` in [`app/actions.ts`](app/actions.ts), [`app/role.tsx`](app/role.tsx)                             |
| Reset override                   | `onReset` in [`app/announcements.tsx`](app/announcements.tsx), `latestAnnouncements` in [`app/actions.ts`](app/actions.ts)                                   |
| Testing your app                 | [`app/messages.test.tsx`](app/messages.test.tsx), [`app/api/webhook/route.test.ts`](app/api/webhook/route.test.ts)                                           |
| Custom transport                 | [`lib/transport.ts`](lib/transport.ts), held to the contract in [`lib/transport.test.ts`](lib/transport.test.ts)                                             |

The two test-shaped patterns run in the `example` Vitest project, after the package is built:
`pnpm run test:example` from the workspace root.

## The workers

Both publish into the App's log from outside Next.js, so they need the server the App runs on
and the Prefix it runs under:

```sh
REDIS_URL=redis://127.0.0.1:6379 NEXT_SSE_PREFIX=next-sse-example \
  pnpm exec tsx examples/basic/worker/publish.ts "we shipped"

REDIS_URL=redis://127.0.0.1:6379 NEXT_SSE_PREFIX=next-sse-example \
  pnpm exec tsx examples/basic/worker/raw-envelope.ts "hello from anywhere"
```

Both appear on every open page at once. Neither writes the App's data — this demo keeps it in
each Instance's memory — so they are gone from the next server render; a real worker writes the
database the page reads, then Publishes.

## The two-Instance run

`compose.yaml` is the manual multi-Instance reference: two containers of this App, one Valkey 8
(Redis commented beside it), and Caddy load-balancing in front of them and streaming SSE.
**Nothing in CI runs it** — the e2e suite already covers two Instances automatically — it is
there to be run by hand, and to be read as the deployment shape the manual describes.

```sh
docker compose -f examples/basic/compose.yaml up --build
```

Then open <http://localhost:8080> in two tabs. What is worth doing once:

- publish in one tab and watch the other, which is on the other container, receive it;
- `docker compose -f examples/basic/compose.yaml stop app-a`: the tab served by that container
  is drained — its Connection is ended with `reconnect` — reopens through Caddy on `app-b`, and
  loses no Message across the cut, because the Connection resumes from its own Cursor;
- `docker compose -f examples/basic/compose.yaml start app-a` and watch new Connections spread
  over both again.

Take it down with `docker compose -f examples/basic/compose.yaml down -v`.
