// PROTOTYPE, variant E. Same server as D (initSSE + colocated authorize), but connect() receives Channel *names*
// and parses them against the registry, as in C: the client builds names from a compiler-checked pattern map.
import type { AnyInstance, EventName, PublishPayload, WireMessage } from '../channel.ts'
import { parse } from '../pattern.ts'
import { validate } from '../standard-schema.ts'
import { initSSE as initD, type AnyServerChannel, type ServerChannel } from '../d/server.ts'

export { type Authorize, type AnyServerChannel, type ServerChannel } from '../d/server.ts'

type InstanceOf<C> = C extends ServerChannel<infer P, infer E, any> ? import('../channel.ts').ChannelInstance<P, E> : never

export interface ConnectResult {
  accepted: boolean
  channels: { name: string; key?: string; params?: Record<string, string>; status: 'allowed' | 'denied' | 'unknown' }[]
}

export interface SSE<Ch extends Record<string, AnyServerChannel<Ctx>>, Ctx> {
  channels: Ch
  publish<I extends InstanceOf<Ch[keyof Ch]>, Ev extends EventName<I>>(instance: I, event: Ev, payload: PublishPayload<I, Ev>): Promise<WireMessage>
  connect(request: Request, names: string[]): Promise<ConnectResult>
  handlers: { GET: (request: Request) => Promise<Response> }
  readonly $ctx: Ctx
}

export function initSSE<Ctx>(init: { context: (request: Request) => Ctx | Promise<Ctx> }) {
  const { channel } = initD(init)

  function createSSE<Ch extends Record<string, AnyServerChannel<Ctx>>>(channels: Ch): SSE<Ch, Ctx> {
    const sse: SSE<Ch, Ctx> = {
      channels,
      async publish(instance: AnyInstance, event: string, payload: unknown) {
        const schema = instance.events[event]
        if (!schema) throw new Error(`unknown event "${event}" on ${instance.pattern}`)
        return { channel: instance.name, event, data: await validate(schema, payload) }
      },
      async connect(request, names) {
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
        async GET(request) {
          const result = await sse.connect(request, new URL(request.url).searchParams.getAll('channel'))
          return new Response(result.accepted ? 'text/event-stream…' : 'forbidden', { status: result.accepted ? 200 : 403 })
        },
      },
      $ctx: undefined as Ctx,
    }
    return sse
  }

  return { channel, createSSE }
}
