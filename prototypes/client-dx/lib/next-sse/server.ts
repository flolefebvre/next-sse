// PROTOTYPE. The server half of a fake next-sse: the Registry of #8 (bound Handles, `chat({ roomId }).message(p)`),
// plus what THIS prototype adds for the server component → client handoff: `sse.cursor()` (one Cursor per request,
// via React `cache`), `sse.snapshot(read)` and `handle.snapshot(read)`, and a `GET` that speaks ADR-0004:
// `ready` → `retry:` → replay → `caught-up` → live, `reset` on a gone Cursor, `reconnect` on Kick, `heartbeat`.
import { cache } from 'react'
import { connection } from 'next/server'
import { append, log, readAfter, tail, type Connection, type Entry } from './log.ts'
import { fill, parse, type Interpolate, type Params, type ParamsArgs } from './pattern.ts'
import { validate, type InferInput, type StandardSchemaV1 } from './standard-schema.ts'

export type EventMap = Record<string, StandardSchemaV1>
export type Authorize<P extends string, Ctx> = (params: Params<P>, ctx: Ctx) => boolean | Promise<boolean>
type Reserved = { name?: never; params?: never; pattern?: never; events?: never; publish?: never; snapshot?: never }

/** What `handle.snapshot(read)` returns: the Channel name, the Cursor taken BEFORE `read`, and the data. Serialisable. */
export interface Snapshot<E extends EventMap, T> {
  readonly channel: string
  readonly cursor: string
  readonly data: T
  readonly $events?: E
}

export interface BoundHandle<P extends string, E extends EventMap> {
  readonly key: string
  readonly pattern: P
  readonly name: Interpolate<P>
  readonly params: Params<P>
  readonly $events?: E
  publish<Ev extends keyof E & string>(event: Ev, payload: InferInput<E[Ev]>): Promise<string>
  snapshot<T>(read: () => T | Promise<T>): Promise<Snapshot<E, T>>
}
export type BoundInstance<P extends string, E extends EventMap> = BoundHandle<P, E> & {
  [Ev in keyof E & string]: (payload: InferInput<E[Ev]>) => Promise<string>
}
export type BoundChannel<P extends string, E extends EventMap, Ctx> = ((...args: ParamsArgs<P>) => BoundInstance<P, E>) & {
  readonly pattern: P
  readonly events: E
  readonly authorize: Authorize<P, Ctx>
}
export type AnyBoundChannel<Ctx> = ((...args: never[]) => BoundHandle<string, EventMap>) & {
  readonly pattern: string
  readonly events: EventMap
  readonly authorize: Authorize<string, Ctx>
}

export type SSE<Ch extends Record<string, AnyBoundChannel<Ctx>>, Ctx> = Ch & {
  channels: Ch
  /** The Cursor for this request: cached per request, so every server component in one render gets the same one. */
  cursor(): Promise<string>
  /** Take the Cursor, then run the read: `{ data, cursor }`, the order enforced for you. */
  snapshot<T>(read: () => T | Promise<T>): Promise<{ data: T; cursor: string }>
  kick(target: { key: string } | BoundHandle<string, EventMap>): Promise<void>
  handlers: { GET: (request: Request) => Promise<Response> }
  readonly $ctx: Ctx
}

export type ClientChannels = Record<string, { pattern: string; events: string[] }>
export function toClientChannels(sse: { channels: Record<string, AnyBoundChannel<any>> }): ClientChannels {
  return Object.fromEntries(Object.entries(sse.channels).map(([key, ch]) => [key, { pattern: ch.pattern, events: Object.keys(ch.events) }]))
}

const encoder = new TextEncoder()
const seqOf = (id: string) => Number(id.split('-')[1])
const frame = (event: string | null, data: unknown, id?: string) =>
  `${id ? `id: ${id}\n` : ''}${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`

export function initSSE<Ctx>(init: { context: (request: Request) => Ctx | Promise<Ctx>; key?: (ctx: Ctx) => string | undefined; heartbeat?: number }) {
  const heartbeat = init.heartbeat ?? 15_000
  const cursor = cache(async () => tail())

  function channel<const P extends string, E extends EventMap & Reserved>(def: { pattern: P; events: E; authorize: Authorize<P, Ctx> }) {
    const bound = (key: string) =>
      Object.assign((...args: unknown[]) => {
        const params = (args[0] ?? {}) as Record<string, string>
        const name = fill(def.pattern, params)
        const publish = async (event: string, payload: unknown) => {
          const schema = def.events[event]
          if (!schema) throw new Error(`unknown event "${event}" on ${def.pattern}`)
          return append({ type: 'message', channel: name, event, payload: await validate(schema, payload) }).id
        }
        const methods = Object.fromEntries(Object.keys(def.events).map((ev) => [ev, (payload: unknown) => publish(ev, payload)]))
        const snapshot = async (read: () => unknown) => {
          const c = await cursor()
          return { channel: name, cursor: c, data: await read() }
        }
        return { key, pattern: def.pattern, name, params, publish, snapshot, ...methods }
      }, { pattern: def.pattern, events: def.events, authorize: def.authorize })
    return Object.assign(bound(def.pattern), { $bind: bound }) as unknown as BoundChannel<P, E, Ctx> & { $bind: typeof bound }
  }

  function createSSE<Ch extends Record<string, AnyBoundChannel<Ctx>>>(defs: Ch & { channels?: never; cursor?: never; snapshot?: never; kick?: never; handlers?: never }): SSE<Ch, Ctx> {
    const channels = Object.fromEntries(Object.entries(defs).map(([key, ch]) => [key, (ch as unknown as { $bind: (k: string) => unknown }).$bind(key)])) as Ch

    async function GET(request: Request): Promise<Response> {
      await connection()
      const url = new URL(request.url)
      const names = url.searchParams.getAll('channel')
      if (names.length === 0) return new Response('no channel', { status: 400 })
      const requested = request.headers.get('last-event-id') ?? url.searchParams.get('cursor')
      const ctx = await init.context(request)
      const key = init.key?.(ctx)
      const allowed = new Set<string>()
      const refused: string[] = []
      for (const name of names) {
        const hit = Object.values(channels).find((ch) => parse(ch.pattern, name))
        const ok = hit ? await hit.authorize(parse(hit.pattern, name)!, ctx) : false
        if (ok) allowed.add(name)
        else refused.push(name)
      }
      if (allowed.size === 0) {
        // every Channel refused: a short 200 stream carrying only `ready`, then close (ADR-0003)
        return new Response(frame('ready', { cursor: null, heartbeat, refused }), { headers: sseHeaders })
      }

      const l = log()
      const id = l.nextConnectionId++
      let conn: Connection
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const write = (s: string) => {
            try { controller.enqueue(encoder.encode(s)) } catch {}
          }
          const finish = () => {
            clearInterval(ticker)
            l.connections.delete(conn)
            try { controller.close() } catch {}
          }
          const replay = requested ? readAfter(requested) : { entries: [] as Entry[] }
          const startCursor = requested && !('gone' in replay) ? requested : tail()
          const live: Entry[] = []
          let phase: 'replay' | 'live' = 'replay'
          conn = {
            id,
            channels: allowed,
            key,
            deliver(entry) {
              if (phase === 'replay') { live.push(entry); return }
              send(entry)
            },
            close(reconnect) {
              if (reconnect) write(frame('reconnect', {}))
              finish()
            },
          }
          const send = (entry: Entry) => {
            if (entry.type === 'control') {
              const hit = (entry.key && entry.key === key) || allowed.has(entry.channel)
              if (hit) conn.close(true)
              return
            }
            if (allowed.has(entry.channel)) write(frame(null, { channel: entry.channel, event: entry.event, payload: entry.payload }, entry.id))
          }
          l.connections.add(conn)
          write(frame('ready', { cursor: startCursor, heartbeat, refused }))
          write('retry: 3000\n\n')
          if ('gone' in replay) write(frame('reset', {}))
          else for (const e of replay.entries) if (e.type === 'message') send(e)
          const last = seqOf(requested && !('gone' in replay) ? (replay.entries.at(-1)?.id ?? requested) : startCursor)
          phase = 'live'
          for (const e of live) if (seqOf(e.id) > last) send(e)
          write(frame('caught-up', {}))
          const ticker = setInterval(() => write(frame('heartbeat', {})), heartbeat)
          request.signal.addEventListener('abort', finish)
        },
        cancel() {
          conn?.close(false)
        },
      })
      return new Response(stream, { headers: sseHeaders })
    }

    const sse = {
      ...channels,
      channels,
      cursor,
      snapshot: async (read: () => unknown) => {
        const c = await cursor()
        return { cursor: c, data: await read() }
      },
      async kick(target: { key: string } | { name: string }) {
        if ('key' in target) {
          if (!init.key) throw new Error('next-sse: kick by key needs initSSE({ key })')
          append({ type: 'control', channel: '', event: 'kick', payload: null, key: target.key })
        } else append({ type: 'control', channel: target.name, event: 'kick', payload: null })
      },
      handlers: { GET },
      $ctx: undefined as Ctx,
    }
    return sse as unknown as SSE<Ch, Ctx>
  }

  return { channel, createSSE }
}

const sseHeaders = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
}
