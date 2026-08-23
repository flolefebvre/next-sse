// PROTOTYPE, variant C. Server-only: createSSE({ context, channels, authorize }) — authorize is a map keyed by
// registry key, exhaustive (a forgotten entry is a compile error), params inferred from each Channel's pattern.
import { type AnyChannel, type AnyInstance, type EventName, type InstanceOf, type PublishPayload, type WireMessage } from '../channel.ts'
import { parse, type Params } from '../pattern.ts'
import { validate } from '../standard-schema.ts'

export type Authorize<P extends string, Ctx> = (params: Params<P>, ctx: Ctx) => boolean | Promise<boolean>

export interface SSEOptions<Ch extends Record<string, AnyChannel>, Ctx> {
  context: (request: Request) => Ctx | Promise<Ctx>
  channels: Ch
  authorize: { [K in keyof Ch]: Authorize<Ch[K]['pattern'], Ctx> }
}

export interface ConnectResult {
  accepted: boolean
  channels: { name: string; key?: string; params?: Record<string, string>; status: 'allowed' | 'denied' | 'unknown' }[]
}

export interface SSE<Ch extends Record<string, AnyChannel>, Ctx> {
  publish<I extends InstanceOf<Ch[keyof Ch]>, Ev extends EventName<I>>(instance: I, event: Ev, payload: PublishPayload<I, Ev>): Promise<WireMessage>
  /** What the GET route handler does on connect: the client asks for Channel *names*, the server parses and authorizes each. */
  connect(request: Request, names: string[]): Promise<ConnectResult>
  handlers: { GET: (request: Request) => Promise<Response> }
  readonly $ctx: Ctx
}

export function createSSE<Ch extends Record<string, AnyChannel>, Ctx>(opts: SSEOptions<Ch, Ctx>): SSE<Ch, Ctx> {
  const sse: SSE<Ch, Ctx> = {
    async publish(instance: AnyInstance, event: string, payload: unknown) {
      const schema = instance.events[event]
      if (!schema) throw new Error(`unknown event "${event}" on ${instance.pattern}`)
      return { channel: instance.name, event, data: await validate(schema, payload) }
    },
    async connect(request, names) {
      const ctx = await opts.context(request)
      const channels: ConnectResult['channels'] = []
      for (const name of names) {
        let hit: { key: string; params: Record<string, string> } | undefined
        for (const [key, channel] of Object.entries(opts.channels)) {
          const params = parse(channel.pattern, name)
          if (params) { hit = { key, params }; break }
        }
        if (!hit) { channels.push({ name, status: 'unknown' }); continue }
        const allowed = await opts.authorize[hit.key]!(hit.params as never, ctx)
        channels.push({ name, ...hit, status: allowed ? 'allowed' : 'denied' })
      }
      return { accepted: channels.every((c) => c.status === 'allowed'), channels }
    },
    handlers: {
      async GET(request) {
        const names = new URL(request.url).searchParams.getAll('channel')
        const result = await sse.connect(request, names)
        return new Response(result.accepted ? 'text/event-stream…' : 'forbidden', { status: result.accepted ? 200 : 403 })
      },
    },
    $ctx: undefined as Ctx,
  }
  return sse
}
