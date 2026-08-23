// PROTOTYPE, variant D. Everything in one server-only call chain: initSSE({ context }) binds the Ctx type, then
// `channel({ pattern, events, authorize })` colocates Authorize with the definition. The client never imports this
// module at runtime (see client.ts): it gets the registry via `import type`.
import { buildChannel, type AnyInstance, type Channel, type EventMap, type EventName, type PublishPayload, type WireMessage } from '../channel.ts'
import { fill, type Params } from '../pattern.ts'
import { validate } from '../standard-schema.ts'

export type Authorize<P extends string, Ctx> = (params: Params<P>, ctx: Ctx) => boolean | Promise<boolean>

export type ServerChannel<P extends string, E extends EventMap, Ctx> = Channel<P, E> & { readonly authorize: Authorize<P, Ctx> }
export type AnyServerChannel<Ctx> = ((...args: never[]) => AnyInstance) & { readonly pattern: string; readonly events: EventMap; readonly authorize: Authorize<string, Ctx> }

type InstanceOf<C> = C extends ServerChannel<infer P, infer E, any> ? import('../channel.ts').ChannelInstance<P, E> : never

export interface ConnectResult {
  accepted: boolean
  channels: { key: string; params: Record<string, string>; name?: string; status: 'allowed' | 'denied' | 'unknown' }[]
}

export interface SSE<Ch extends Record<string, AnyServerChannel<Ctx>>, Ctx> {
  channels: Ch
  publish<I extends InstanceOf<Ch[keyof Ch]>, Ev extends EventName<I>>(instance: I, event: Ev, payload: PublishPayload<I, Ev>): Promise<WireMessage>
  /** On connect the client sends { key, params } pairs: no name parsing; the name is minted server-side. */
  connect(request: Request, requested: { key: string; params: Record<string, string> }[]): Promise<ConnectResult>
  handlers: { GET: (request: Request) => Promise<Response> }
  readonly $ctx: Ctx
}

export function initSSE<Ctx>(init: { context: (request: Request) => Ctx | Promise<Ctx> }) {
  function channel<const P extends string, E extends EventMap>(def: { pattern: P; events: E; authorize: Authorize<P, Ctx> }): ServerChannel<P, E, Ctx> {
    return Object.assign(buildChannel(def.pattern, def.events), { authorize: def.authorize })
  }

  function createSSE<Ch extends Record<string, AnyServerChannel<Ctx>>>(channels: Ch): SSE<Ch, Ctx> {
    const sse: SSE<Ch, Ctx> = {
      channels,
      async publish(instance: AnyInstance, event: string, payload: unknown) {
        const schema = instance.events[event]
        if (!schema) throw new Error(`unknown event "${event}" on ${instance.pattern}`)
        return { channel: instance.name, event, data: await validate(schema, payload) }
      },
      async connect(request, requested) {
        const ctx = await init.context(request)
        const results: ConnectResult['channels'] = []
        for (const { key, params } of requested) {
          const channel = channels[key]
          if (!channel) { results.push({ key, params, status: 'unknown' }); continue }
          const allowed = await channel.authorize(params as never, ctx)
          results.push({ key, params, name: fill(channel.pattern, params), status: allowed ? 'allowed' : 'denied' })
        }
        return { accepted: results.every((c) => c.status === 'allowed'), channels: results }
      },
      handlers: {
        async GET(request) {
          const requested = JSON.parse(new URL(request.url).searchParams.get('channels') ?? '[]')
          const result = await sse.connect(request, requested)
          return new Response(result.accepted ? 'text/event-stream…' : 'forbidden', { status: result.accepted ? 200 : 403 })
        },
      },
      $ctx: undefined as Ctx,
    }
    return sse
  }

  return { channel, createSSE }
}
