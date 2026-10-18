# @flefebvre/next-sse

Typed, authorization-aware pub/sub over Server-Sent Events for Next.js. One Instance or many
behind a load balancer, with the same code and the same guarantee: no Message lost or delivered
twice across reconnects, redeploys, or the window between a server render and the stream going
live.

This is the manual that ships inside the package, so it describes the version installed next to
it. Read the file for the job at hand.

## Which file for which job

| Job                                                             | File                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| Understand the words this library uses                          | [core-concepts.md](core-concepts.md)                              |
| Install it and get the first Message on screen                  | [setup.md](setup.md)                                              |
| Declare Channels, publish, kick, drain, hand data to the client | [server.md](server.md)                                            |
| Subscribe from a component, own list state, handle Reset        | [client.md](client.md)                                            |
| Choose or configure a Transport, or write one                   | [transport.md](transport.md)                                      |
| Test an App that uses this library                              | [testing.md](testing.md)                                          |
| Publish from a service that does not have this library          | [wire-format.md](wire-format.md)                                  |
| Put it behind a proxy, run several Instances, redeploy          | [deployment.md](deployment.md)                                    |
| Decide whether SSE is the right tool at all                     | [when-not-to-use-sse.md](when-not-to-use-sse.md)                  |
| Copy a working recipe                                           | [patterns/index.md](patterns/index.md) — ten, each standing alone |

## Import map

Six subpaths, and no root export.

| Import from                            | Holds                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@flefebvre/next-sse/server`           | `initSSE`, `SSEProvider`, `toClientChannels`, `asType`, `InvalidPayloadError`, and the server types (`Registry`, `Handle`, `Authorize`, `JsonValue`) |
| `@flefebvre/next-sse/client`           | `createClient`, `SSEClientProvider`, `upsertBy`, and the client types (`Snapshot`, `Status`, `ChannelState`)                                         |
| `@flefebvre/next-sse/transport`        | the `Transport` and `Publisher` contracts, `createPublisher`, `TransportError`, `TransportUnavailableError`, `TransportClosedError`                  |
| `@flefebvre/next-sse/transport/memory` | `createMemoryTransport`                                                                                                                              |
| `@flefebvre/next-sse/transport/redis`  | `createRedisTransport`, `createRedisPublisher`                                                                                                       |
| `@flefebvre/next-sse/testing`          | `transportContract`, `FakeEventSource`, `fakeEventSources`, `snapshotOf`                                                                             |

## Iron rules

1. **Import a subpath, never the package.** `import … from "@flefebvre/next-sse"` does not
   resolve; there is no root export.
2. **`./server` is for server code.** Server Components, route handlers, server actions, and an
   App's own tests of them: it resolves to the implementation under every condition, so plain
   Node loads it too. Client Components import `./client`; keeping the Registry out of them is
   the App's call ([server.md](server.md)).
3. **Publish through Handles only.** `sse.chat({ roomId }).message(payload)`. There is no
   generic `sse.publish`; the escape hatch is the Transport's own `publish`.
4. **Authorize runs at connect and at every reconnect, per Channel, never per Message.** A
   refused Channel is dropped from the Connection; the others keep streaming.
5. **Reserved names.** A Channel may not be called `handlers`, `channels`, `cursor`,
   `snapshot`, `kick` or `drain`; an event may not be called `publish`, `snapshot`, `pattern`,
   `params` or `name`. Both are compile errors and runtime throws.
6. **Two Channel patterns may not be able to produce the same Channel name.** `createSSE`
   refuses the Registry and names both declarations.
7. **All configuration goes on `initSSE`.** `createSSE` takes the Channel record and nothing
   else.
8. **The `Snapshot` is opaque.** `sse.snapshot(read)` mints one, a hook spends one; App code
   never sees a Cursor.
9. **Requirements**: Next.js ≥ 16.3.0, React ≥ 19.2.0, Node ≥ 22.12, ESM only, App Router only.
   `redis` is a plain dependency, imported lazily — an App on the Memory Transport never loads
   it.
10. **The installed `.d.ts` wins.** If a snippet here disagrees with the types in
    `node_modules`, the types are right.
