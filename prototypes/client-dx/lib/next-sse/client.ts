'use client'
// PROTOTYPE. `createClient<typeof sse>()`: typed Handles from the Registry (ADR-0002) plus the three hook shapes
// this prototype puts side by side. Each variant page uses exactly one of them:
//   A  useChannel(handle, handlers, { cursor, onReset })        you own the state, the hook only calls handlers
//   B  useChannelState(handle, snapshot, reducers)              the hook owns the state, seeded from a snapshot
//   C  useLive(snapshot, reducers)                              the snapshot carries the Channel too; no Handle
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useSSEContext } from './client-provider.tsx'
import type { Phase, Status } from './core.ts'
import { fill, type Params, type ParamsArgs } from './pattern.ts'
import type { AnyBoundChannel, ChannelSnapshot, EventMap, SSE, Snapshot } from './server.ts'
import type { InferOutput } from './standard-schema.ts'

export type { Status }
export type { Snapshot } from './server.ts'

/** Reducer sugar for the common "list keyed by id" merge: replace the item with the same key, else append.
 * Absorbs the snapshot/replay overlap, a Kick's replay and an action echo alike. */
export function upsertBy<K extends PropertyKey>(key: K): <M extends Record<K, unknown>>(list: M[], item: M) => M[]
export function upsertBy<M>(key: (item: M) => unknown): (list: M[], item: M) => M[]
export function upsertBy(key: PropertyKey | ((item: any) => unknown)): (list: any[], item: any) => any[] {
  const keyOf = typeof key === 'function' ? key : (item: any) => item[key]
  return (list, item) => (list.some((x) => keyOf(x) === keyOf(item)) ? list.map((x) => (keyOf(x) === keyOf(item) ? item : x)) : [...list, item])
}

export interface Handle<K extends string, P extends string, E extends EventMap> {
  readonly key: K
  readonly params: Params<P>
  readonly $events?: E
}
type AnyHandle = Handle<string, string, EventMap>
type EventsOf<X extends { $events?: EventMap }> = NonNullable<X['$events']>
export type Handlers<E extends EventMap> = { [Ev in keyof E & string]?: (payload: InferOutput<E[Ev]>, phase: Phase) => void }
export type Reducers<E extends EventMap, T> = { [Ev in keyof E & string]?: (state: T, payload: InferOutput<E[Ev]>) => T }

type ChannelsOf<S> = S extends SSE<infer Ch, any> ? Ch : never
type Handles<Ch extends Record<string, AnyBoundChannel<any>>> = {
  [K in keyof Ch & string]: (...args: ParamsArgs<Ch[K]['pattern']>) => Handle<K, Ch[K]['pattern'], Ch[K]['events']>
}
type HandleOf<S> = { [K in keyof ChannelsOf<S> & string]: Handle<K, ChannelsOf<S>[K]['pattern'], ChannelsOf<S>[K]['events']> }[keyof ChannelsOf<S> & string]

export function createClient<S extends SSE<any, any>>() {
  const channels = new Proxy({} as Handles<ChannelsOf<S>>, {
    get: (_, key: string) => (params: Record<string, string> = {}) => ({ key, params }),
  })

  function useName(handle: AnyHandle) {
    const { channels } = useSSEContext()
    const config = channels[handle.key]
    if (!config) throw new Error(`next-sse: unknown Channel "${handle.key}"`)
    return fill(config.pattern, handle.params as Record<string, string>)
  }

  /** The primitive all three build on: subscribe by name, deliver to a ref'd handler, report status. */
  function useSubscription(name: string, cursor: string | undefined, onMessage: (event: string, payload: unknown, phase: Phase) => void, onReset?: () => void) {
    const { core, onReset: defaultReset } = useSSEContext()
    const [status, setStatus] = useState<Status>('connecting')
    const latest = useRef({ onMessage, onReset: onReset ?? defaultReset })
    latest.current = { onMessage, onReset: onReset ?? defaultReset }
    useEffect(
      () =>
        core.subscribe({
          channel: name,
          cursor,
          onMessage: (event, payload, phase) => latest.current.onMessage(event, payload, phase),
          onStatus: setStatus,
          onReset: () => latest.current.onReset(),
        }),
      [core, name, cursor],
    )
    return status
  }

  // ---- A ----
  function useChannel<H extends HandleOf<S>>(handle: H, handlers: Handlers<EventsOf<H>>, options: { cursor?: string; onReset?: () => void } = {}) {
    const name = useName(handle)
    const status = useSubscription(name, options.cursor, (event, payload, phase) => (handlers as Record<string, (p: unknown, ph: Phase) => void>)[event]?.(payload, phase), options.onReset)
    return { status, name }
  }

  // ---- B ----
  function useChannelState<H extends HandleOf<S>, T>(handle: H, snapshot: Snapshot<T>, reducers: Reducers<EventsOf<H>, T>, options: { onReset?: () => void } = {}) {
    const name = useName(handle)
    const [state, setState] = useState(snapshot.data)
    const [seen, setSeen] = useState(snapshot)
    if (seen !== snapshot) {
      // a new snapshot arrived (router.refresh after a Reset, or any re-render of the server component): restart from it
      setSeen(snapshot)
      setState(snapshot.data)
    }
    const apply = <Ev extends keyof EventsOf<H> & string>(event: Ev, payload: InferOutput<EventsOf<H>[Ev]>) => {
      const reduce = (reducers as Record<string, (s: T, p: unknown) => T>)[event]
      if (reduce) setState((s) => reduce(s, payload))
    }
    const status = useSubscription(name, snapshot.cursor, (event, payload) => apply(event as keyof EventsOf<H> & string, payload as never), options.onReset)
    return { state, status, name, apply }
  }

  // ---- C ----
  function useLive<E extends EventMap, T>(snapshot: ChannelSnapshot<E, T>, reducers: Reducers<E, T>, options: { onReset?: () => void } = {}) {
    const [state, setState] = useState(snapshot.data)
    const [seen, setSeen] = useState(snapshot)
    if (seen !== snapshot) {
      setSeen(snapshot)
      setState(snapshot.data)
    }
    const apply = <Ev extends keyof E & string>(event: Ev, payload: InferOutput<E[Ev]>) => {
      const reduce = (reducers as Record<string, (s: T, p: unknown) => T>)[event]
      if (reduce) setState((s) => reduce(s, payload))
    }
    const status = useSubscription(snapshot.channel, snapshot.cursor, (event, payload) => apply(event as keyof E & string, payload as never), options.onReset)
    return [state, { status, apply, name: snapshot.channel }] as const
  }

  /** Debug only: the core's trace, for the prototype's panel. */
  function useCoreTrace() {
    const { core } = useSSEContext()
    const version = useRef(0)
    return useSyncExternalStore(
      (cb) => core.onChange(() => { version.current++; cb() }),
      () => version.current,
      () => 0,
    ), core.snapshot
  }

  return { channels, useChannel, useChannelState, useLive, useCoreTrace }
}

/** The type of `handle.snapshot(read)` for Channel `K` of Registry `S`, for a client component's props. */
export type SnapshotOf<S, K extends keyof ChannelsOf<S> & string, T> = ChannelSnapshot<ChannelsOf<S>[K]['events'], T>
