// PROTOTYPE, variant H (= G with bound handles). createSSE returns Channels that are bound to the App:
// `chat({ roomId })` yields an instance carrying `publish(event, payload)` AND one method per event
// (`.message(payload)`). No `sse.publish(chat(...))` double step. Event names `name`, `params`, `pattern`,
// `events`, `publish` are reserved (compile error); registry keys `channels`, `connect`, `handlers` too.
import { buildChannel, type AnyInstance, type ChannelInstance, type EventMap, type WireMessage } from '../channel.ts'
import { parse, type Params, type ParamsArgs } from '../pattern.ts'
import { validate, type InferInput } from '../standard-schema.ts'

export type Authorize<P extends string, Ctx> = (params: Params<P>, ctx: Ctx) => boolean | Promise<boolean>

type Reserved = { name?: never; params?: never; pattern?: never; events?: never; publish?: never }

export type BoundInstance<P extends string, E extends EventMap> = ChannelInstance<P, E> & {
  publish<Ev extends keyof E & string>(event: Ev, payload: InferInput<E[Ev]>): Promise<WireMessage>
} & { [Ev in keyof E & string]: (payload: InferInput<E[Ev]>) => Promise<WireMessage> }

export type BoundChannel<P extends string, E extends EventMap, Ctx> = ((...args: ParamsArgs<P>) => BoundInstance<P, E>) & {
  readonly pattern: P
  readonly events: E
  readonly authorize: Authorize<P, Ctx>
}
export type AnyBoundChannel<Ctx> = ((...args: never[]) => AnyInstance) & { readonly pattern: string; readonly events: EventMap; readonly authorize: Authorize<string, Ctx> }

export interface ConnectResult {
  accepted: boolean
  channels: { name: string; key?: string; params?: Record<string, string>; status: 'allowed' | 'denied' | 'unknown' }[]
}

export type SSE<Ch extends Record<string, AnyBoundChannel<Ctx>>, Ctx> = Ch & {
  channels: Ch
  connect(request: Request, names: string[]): Promise<ConnectResult>
  handlers: { GET: (request: Request) => Promise<Response> }
  readonly $ctx: Ctx
}

export function initSSE<Ctx>(init: { context: (request: Request) => Ctx | Promise<Ctx> }) {
  async function publish(instance: AnyInstance, event: string, payload: unknown): Promise<WireMessage> {
    const schema = instance.events[event]
    if (!schema) throw new Error(`unknown event "${event}" on ${instance.pattern}`)
    return { channel: instance.name, event, data: await validate(schema, payload) }
  }

  function channel<const P extends string, E extends EventMap & Reserved>(def: { pattern: P; events: E; authorize: Authorize<P, Ctx> }): BoundChannel<P, E, Ctx> {
    const plain = buildChannel(def.pattern, def.events)
    const bound = (...args: never[]) => {
      const instance = (plain as unknown as (...a: unknown[]) => AnyInstance)(...args)
      const methods = Object.fromEntries(Object.keys(def.events).map((ev) => [ev, (payload: unknown) => publish(instance, ev, payload)]))
      return { ...instance, ...methods, publish: (ev: string, payload: unknown) => publish(instance, ev, payload) }
    }
    return Object.assign(bound, { pattern: def.pattern, events: def.events, authorize: def.authorize }) as unknown as BoundChannel<P, E, Ctx>
  }

  function createSSE<Ch extends Record<string, AnyBoundChannel<Ctx>>>(channels: Ch & { channels?: never; connect?: never; handlers?: never }): SSE<Ch, Ctx> {
    const sse = {
      ...channels,
      channels,
      async connect(request: Request, names: string[]) {
        const ctx = await init.context(request)
        const results: ConnectResult['channels'] = []
        for (const name of names) {
          let hit: { key: string; params: Record<string, string> } | undefined
          for (const [key, ch] of Object.entries(channels)) {
            const params = parse(ch.pattern, name)
            if (params) { hit = { key, params }; break }
          }
          if (!hit) { results.push({ name, status: 'unknown' }); continue }
          const allowed = await channels[hit.key]!.authorize(hit.params as never, ctx)
          results.push({ name, ...hit, status: allowed ? 'allowed' : 'denied' })
        }
        return { accepted: results.every((c) => c.status === 'allowed'), channels: results }
      },
      handlers: {
        async GET(request: Request) {
          const result = await sse.connect(request, new URL(request.url).searchParams.getAll('channel'))
          return new Response(result.accepted ? 'text/event-stream…' : 'forbidden', { status: result.accepted ? 200 : 403 })
        },
      },
      $ctx: undefined as Ctx,
    }
    return sse as unknown as SSE<Ch, Ctx>
  }

  return { channel, createSSE }
}

export type ClientChannels = Record<string, { pattern: string; events: string[] }>

/** The allowlist that <SSEProvider> sends down (same as G). */
export function toClientChannels(sse: { channels: Record<string, AnyBoundChannel<any>> }): ClientChannels {
  return Object.fromEntries(Object.entries(sse.channels).map(([key, ch]) => [key, { pattern: ch.pattern, events: Object.keys(ch.events) }]))
}
