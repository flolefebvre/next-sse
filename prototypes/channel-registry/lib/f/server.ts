// PROTOTYPE, variant F. `channelWith<Ctx>()` returns a `channel()` builder for a SHARED module: pattern, events and
// authorize together, where authorize may only use (params, ctx). The ctx type is imported with `import type` from
// the server-only module that defines `context(request)`, so the shared file has no server imports.
import { buildChannel, type AnyInstance, type EventMap, type EventName, type PublishPayload, type WireMessage } from '../channel.ts'
import { parse } from '../pattern.ts'
import { validate } from '../standard-schema.ts'
import type { AnyServerChannel, Authorize, ServerChannel } from '../d/server.ts'

export function channelWith<Ctx>() {
  return function channel<const P extends string, E extends EventMap>(def: { pattern: P; events: E; authorize: Authorize<P, Ctx> }): ServerChannel<P, E, Ctx> {
    return Object.assign(buildChannel(def.pattern, def.events), { authorize: def.authorize })
  }
}

type InstanceOf<C> = C extends ServerChannel<infer P, infer E, any> ? import('../channel.ts').ChannelInstance<P, E> : never

export interface ConnectResult {
  accepted: boolean
  channels: { name: string; key?: string; params?: Record<string, string>; status: 'allowed' | 'denied' | 'unknown' }[]
}

export interface SSE<Ch extends Record<string, AnyServerChannel<Ctx>>, Ctx> {
  publish<I extends InstanceOf<Ch[keyof Ch]>, Ev extends EventName<I>>(instance: I, event: Ev, payload: PublishPayload<I, Ev>): Promise<WireMessage>
  connect(request: Request, names: string[]): Promise<ConnectResult>
  handlers: { GET: (request: Request) => Promise<Response> }
}

export function createSSE<Ch extends Record<string, AnyServerChannel<Ctx>>, Ctx>(opts: { context: (request: Request) => Ctx | Promise<Ctx>; channels: Ch }): SSE<Ch, Ctx> {
  const sse: SSE<Ch, Ctx> = {
    async publish(instance: AnyInstance, event: string, payload: unknown) {
      const schema = instance.events[event]
      if (!schema) throw new Error(`unknown event "${event}" on ${instance.pattern}`)
      return { channel: instance.name, event, data: await validate(schema, payload) }
    },
    async connect(request, names) {
      const ctx = await opts.context(request)
      const results: ConnectResult['channels'] = []
      for (const name of names) {
        let hit: { key: string; params: Record<string, string> } | undefined
        for (const [key, ch] of Object.entries(opts.channels)) {
          const params = parse(ch.pattern, name)
          if (params) { hit = { key, params }; break }
        }
        if (!hit) { results.push({ name, status: 'unknown' }); continue }
        const allowed = await opts.channels[hit.key]!.authorize(hit.params as never, ctx)
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
  }
  return sse
}
