// PROTOTYPE, variant E. `createClient<typeof sse>(patterns)`: the client restates each Channel's pattern, and the
// compiler checks the map against the server registry's literal types (missing key, extra key or a different
// string are all errors). With the pattern in hand the client builds real Channel names, as in C.
import { buildChannel, subscriptions, type AnyInstance, type Channel, type Handlers } from '../channel.ts'
import type { AnyServerChannel, SSE } from './server.ts'

type ChannelsOf<S> = S extends SSE<infer Ch, any> ? Ch : never
type Patterns<Ch extends Record<string, AnyServerChannel<any>>> = { [K in keyof Ch]: Ch[K]['pattern'] }
type ClientChannels<Ch extends Record<string, AnyServerChannel<any>>> = { [K in keyof Ch]: Channel<Ch[K]['pattern'], Ch[K]['events']> }

export function createClient<S extends SSE<any, any>>(patterns: Patterns<ChannelsOf<S>>) {
  const channels = Object.fromEntries(
    Object.entries(patterns as Record<string, string>).map(([key, pattern]) => [key, buildChannel(pattern, {})]),
  ) as ClientChannels<ChannelsOf<S>>
  function useChannel<I extends AnyInstance>(instance: I, handlers: Handlers<I>): void {
    subscriptions.push({ name: instance.name, events: Object.keys(handlers) })
  }
  return { channels, useChannel }
}
