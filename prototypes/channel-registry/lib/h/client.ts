// PROTOTYPE, variant H client. Same as G (handles from the type, patterns from <SSEProvider> data), plus
// generated hooks: `channels.useChat({ roomId }, handlers)` next to `useChannel(channels.chat({ roomId }), handlers)`.
import { subscriptions, type EventMap } from '../channel.ts'
import { fill, type Params, type ParamsArgs } from '../pattern.ts'
import type { InferOutput } from '../standard-schema.ts'
import { useClientChannels } from '../g/client-provider.ts'
import type { AnyBoundChannel, ClientChannels, SSE } from './server.ts'

export interface Handle<K extends string, P extends string, E extends EventMap> {
  readonly key: K
  readonly params: Params<P>
  readonly $events?: E
}
type AnyHandle = Handle<string, string, EventMap>
type EventName<H extends AnyHandle> = keyof NonNullable<H['$events']> & string
type Handlers<H extends AnyHandle> = { [Ev in EventName<H>]?: (payload: InferOutput<NonNullable<H['$events']>[Ev]>) => void }

type ChannelsOf<S> = S extends SSE<infer Ch, any> ? Ch : never
type Handles<Ch extends Record<string, AnyBoundChannel<any>>> = {
  [K in keyof Ch & string]: (...args: ParamsArgs<Ch[K]['pattern']>) => Handle<K, Ch[K]['pattern'], Ch[K]['events']>
} & {
  [K in keyof Ch & string as `use${Capitalize<K>}`]: (
    ...args: [...ParamsArgs<Ch[K]['pattern']>, handlers: Handlers<Handle<K, Ch[K]['pattern'], Ch[K]['events']>>]
  ) => { name: string }
}
type HandleOf<S> = { [K in keyof ChannelsOf<S> & string]: Handle<K, ChannelsOf<S>[K]['pattern'], ChannelsOf<S>[K]['events']> }[keyof ChannelsOf<S> & string]

export function createClient<S extends SSE<any, any>>(readChannels: () => ClientChannels = useClientChannels) {
  function useChannel<H extends HandleOf<S>>(handle: H, handlers: Handlers<H>): { name: string } {
    const config = readChannels()[handle.key]
    if (!config) throw new Error(`next-sse: unknown Channel "${handle.key}"`)
    const name = fill(config.pattern, handle.params as Record<string, string>)
    subscriptions.push({ name, events: Object.keys(handlers) })
    return { name }
  }
  const channels = new Proxy({} as Handles<ChannelsOf<S>>, {
    get: (_, prop: string) => {
      const hook = /^use([A-Z])(.*)$/.exec(prop)
      if (hook) {
        const key = hook[1]!.toLowerCase() + hook[2]!
        return (...args: unknown[]) => {
          const handlers = args.pop() as Record<string, unknown>
          return useChannel({ key, params: (args[0] ?? {}) as Record<string, string> } as never, handlers as never)
        }
      }
      return (params: Record<string, string> = {}) => ({ key: prop, params })
    },
  })
  return { channels, useChannel }
}
