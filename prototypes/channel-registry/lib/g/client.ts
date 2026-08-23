// PROTOTYPE, variant G. `createClient<typeof sse>()`: typed handles from the server registry's TYPE (erased),
// patterns from the provider's DATA (at render time). A handle is { key, params }; useChannel reads the pattern
// from context, builds the real Channel name for the Connection, and returns it.
import { subscriptions, type EventMap } from '../channel.ts'
import { fill, type Params, type ParamsArgs } from '../pattern.ts'
import type { InferOutput } from '../standard-schema.ts'
import type { AnyServerChannel, SSE } from '../e/server.ts'
import { useClientChannels } from './client-provider.ts'
import type { ClientChannels } from './server.ts'

export interface Handle<K extends string, P extends string, E extends EventMap> {
  readonly key: K
  readonly params: Params<P>
  readonly $events?: E
}
type AnyHandle = Handle<string, string, EventMap>

type ChannelsOf<S> = S extends SSE<infer Ch, any> ? Ch : never
type Handles<Ch extends Record<string, AnyServerChannel<any>>> = {
  [K in keyof Ch & string]: (...args: ParamsArgs<Ch[K]['pattern']>) => Handle<K, Ch[K]['pattern'], Ch[K]['events']>
}
type EventName<H extends AnyHandle> = keyof NonNullable<H['$events']> & string
type Handlers<H extends AnyHandle> = { [Ev in EventName<H>]?: (payload: InferOutput<NonNullable<H['$events']>[Ev]>) => void }

export function createClient<S extends SSE<any, any>>(readChannels: () => ClientChannels = useClientChannels) {
  const channels = new Proxy({} as Handles<ChannelsOf<S>>, {
    get: (_, key: string) => (params: Record<string, string> = {}) => ({ key, params }),
  })
  function useChannel<H extends ReturnType<Handles<ChannelsOf<S>>[keyof Handles<ChannelsOf<S>>]>>(handle: H, handlers: Handlers<H>): { name: string } {
    const config = readChannels()[handle.key]
    if (!config) throw new Error(`next-sse: unknown Channel "${handle.key}"`)
    const name = fill(config.pattern, handle.params as Record<string, string>)
    subscriptions.push({ name, events: Object.keys(handlers) })
    return { name }
  }
  return { channels, useChannel }
}
