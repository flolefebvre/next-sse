// PROTOTYPE, variant G. Server side is exactly E's (one server-only registry, authorize colocated, connect parses
// names). The addition is `toClientChannels(sse)`: an explicit ALLOWLIST of what may cross to the client, as data.
// Anything not listed here (authorize, context, schemas) never leaves the server: it fails closed.
import type { AnyServerChannel, SSE } from '../e/server.ts'

export { initSSE } from '../e/server.ts'

export type ClientChannels = Record<string, { pattern: string; events: string[] }>

export function toClientChannels(sse: SSE<Record<string, AnyServerChannel<any>>, any>): ClientChannels {
  return Object.fromEntries(
    Object.entries(sse.channels).map(([key, ch]) => [key, { pattern: ch.pattern, events: Object.keys(ch.events) }]),
  )
}
