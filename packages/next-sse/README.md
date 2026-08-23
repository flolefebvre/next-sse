# @flefebvre/next-sse

Live server-to-client updates for Next.js apps over Server-Sent Events, working identically on one
Instance and on many Instances behind a load balancer.

**Not usable yet.** Every entry point of this package is a stub that throws: v0.1 is under
construction, and this release exists so that the workspace, the exports map and the quality gate are
in place before the protocol lands.

## Entry points

| Entry                | Holds                                                       |
| -------------------- | ----------------------------------------------------------- |
| `./server`           | `initSSE`, `SSEProvider`, `toClientChannels`                 |
| `./client`           | `createClient`, `SSEClientProvider`, `upsertBy`              |
| `./transport`        | the `Transport` contract, its error classes, `createPublisher` |
| `./transport/memory` | `createMemoryTransport`                                      |
| `./transport/redis`  | `createRedisTransport`, `createRedisPublisher`                |
| `./testing`          | `transportContract`, `FakeEventSource`                        |

There is no root export: importing `@flefebvre/next-sse` itself is an error, and `./server` resolves
to a module that throws unless it is loaded under the `react-server` condition.

## License

MIT
