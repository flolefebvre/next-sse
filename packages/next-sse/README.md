# @flefebvre/next-sse

Live server-to-client updates for Next.js apps over Server-Sent Events, working identically on one
Instance and on many Instances behind a load balancer.

## Entry points

| Entry                | Holds                                                          |
| -------------------- | -------------------------------------------------------------- |
| `./server`           | `initSSE`, `SSEProvider`, `toClientChannels`                   |
| `./client`           | `createClient`, `SSEClientProvider`, `upsertBy`                |
| `./transport`        | the `Transport` contract, its error classes, `createPublisher` |
| `./transport/memory` | `createMemoryTransport`                                        |
| `./transport/redis`  | `createRedisTransport`, `createRedisPublisher`                 |
| `./testing`          | `transportContract`, `FakeEventSource`, `fakeEventSources`     |

There is no root export: importing `@flefebvre/next-sse` itself is an error, and `./server` resolves
to a module that throws unless it is loaded under the `react-server` condition.

## License

MIT
