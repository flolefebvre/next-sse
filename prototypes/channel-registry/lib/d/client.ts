// PROTOTYPE, variant D. `createClient<typeof sse>()` builds a Proxy registry from the *type* of the server
// instance: `channels.chat({ roomId })` yields { key: 'chat', params } with the events typed, and no pattern,
// schema or authorize code reaches the client bundle.
import { subscriptions, type EventMap } from '../channel.ts'
import type { InferOutput } from '../standard-schema.ts'
import type { Params, ParamsArgs } from '../pattern.ts'
import type { AnyServerChannel, SSE } from './server.ts'

export interface ClientInstance<K extends string, P extends string, E extends EventMap> {
  readonly key: K
  readonly params: Params<P>
  readonly $events?: E
}
type AnyClientInstance = ClientInstance<string, string, EventMap>

type ChannelsOf<S> = S extends SSE<infer Ch, any> ? Ch : never
type ClientChannels<Ch extends Record<string, AnyServerChannel<any>>> = {
  [K in keyof Ch & string]: (...args: ParamsArgs<Ch[K]['pattern']>) => ClientInstance<K, Ch[K]['pattern'], Ch[K]['events']>
}
type EventName<I extends AnyClientInstance> = keyof NonNullable<I['$events']> & string
type Handlers<I extends AnyClientInstance> = { [Ev in EventName<I>]?: (payload: InferOutput<NonNullable<I['$events']>[Ev]>) => void }

export function createClient<S extends SSE<any, any>>() {
  const channels = new Proxy({} as ClientChannels<ChannelsOf<S>>, {
    get: (_, key: string) => (params: Record<string, string> = {}) => ({ key, params }),
  })
  function useChannel<I extends ReturnType<ClientChannels<ChannelsOf<S>>[keyof ClientChannels<ChannelsOf<S>>]>>(instance: I, handlers: Handlers<I>): void {
    subscriptions.push({ name: `${instance.key} ${JSON.stringify(instance.params)}`, events: Object.keys(handlers) })
  }
  return { channels, useChannel }
}
