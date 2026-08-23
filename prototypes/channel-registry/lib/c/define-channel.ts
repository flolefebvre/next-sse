// PROTOTYPE, variant C. Shared module: `defineChannel({ pattern, events })`. No Authorize here, so the file is
// safe to import from Client Components; Authorize is attached in createSSE (server-only).
import { buildChannel, type Channel, type EventMap } from '../channel.ts'

export function defineChannel<const P extends string, E extends EventMap>(def: { pattern: P; events: E }): Channel<P, E> {
  return buildChannel(def.pattern, def.events)
}
