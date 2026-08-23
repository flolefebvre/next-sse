// PROTOTYPE. What both variants share: a Channel definition is a pattern plus a map of event name → payload schema,
// and a Channel *instance* (`chat({ roomId })`) is the typed handle that publish / useChannel / authorize agree on.
import type { InferInput, InferOutput, StandardSchemaV1 } from './standard-schema.ts'
import { fill, type Interpolate, type Params, type ParamsArgs } from './pattern.ts'

export type EventMap = Record<string, StandardSchemaV1>

export interface ChannelInstance<P extends string, E extends EventMap> {
  readonly pattern: P
  readonly name: Interpolate<P>
  readonly params: Params<P>
  readonly events: E
}
export type AnyInstance = ChannelInstance<string, EventMap>

export type Channel<P extends string, E extends EventMap> = ((...args: ParamsArgs<P>) => ChannelInstance<P, E>) & {
  readonly pattern: P
  readonly events: E
}
export type AnyChannel = ((...args: never[]) => AnyInstance) & { readonly pattern: string; readonly events: EventMap }
export type InstanceOf<C> = C extends Channel<infer P, infer E> ? ChannelInstance<P, E> : never

export type EventName<I extends AnyInstance> = keyof I['events'] & string
export type PublishPayload<I extends AnyInstance, Ev extends EventName<I>> = InferInput<I['events'][Ev]>
export type ReceivedPayload<I extends AnyInstance, Ev extends EventName<I>> = InferOutput<I['events'][Ev]>
export type Handlers<I extends AnyInstance> = { [Ev in EventName<I>]?: (payload: ReceivedPayload<I, Ev>) => void }

export function buildChannel<P extends string, E extends EventMap>(pattern: P, events: E): Channel<P, E> {
  const build = (...args: unknown[]) => {
    const params = (args[0] ?? {}) as Params<P>
    return { pattern, name: fill(pattern, params as Record<string, string>), params, events }
  }
  return Object.assign(build, { pattern, events }) as Channel<P, E>
}

export interface WireMessage {
  channel: string
  event: string
  data: unknown
}

/** Fake client hook: records subscriptions so the demo can print them. */
export const subscriptions: { name: string; events: string[] }[] = []
