// PROTOTYPE. Never imported: what must NOT compile. `pnpm check` fails if any @ts-expect-error stops firing.
import type { Message } from './db'
import { chat, sse } from './sse'
import { channels, useChannel, useChannelState, useLive } from './sse.client'
import type { SnapshotOf } from '@/lib/next-sse/client'

export async function server() {
  await chat({ roomId: '1' }).message({ id: '1', roomId: '1', author: 'a', text: 'hi', at: 1 })
  const snap = await chat({ roomId: '1' }).snapshot(async () => [] as Message[])
  snap.data satisfies Message[]
  const plain = await sse.snapshot(async () => 42)
  plain.data satisfies number
  // @ts-expect-error roomId is required
  chat({})
  // @ts-expect-error wrong payload
  await chat({ roomId: '1' }).typing({ text: 'hi' })
  // @ts-expect-error no such event
  await chat({ roomId: '1' }).mesage({})
  // @ts-expect-error no such Channel
  sse.rogue()
}

export function client(live: SnapshotOf<typeof sse, 'chat', Message[]>, snapshot: { data: Message[]; cursor: string }) {
  useChannel(channels.chat({ roomId: '1' }), { message: (m) => m.text.toUpperCase(), typing: (t) => t.author })
  // @ts-expect-error roomId is required
  channels.chat({})
  // @ts-expect-error no such Channel
  channels.rogue()
  useChannel(channels.chat({ roomId: '1' }), {
    // @ts-expect-error payload is the zod Output type
    message: (m) => m.text.toFixed(),
  })
  useChannel(channels.chat({ roomId: '1' }), {
    // @ts-expect-error unknown event
    nope: () => {},
  })

  const { state } = useChannelState(channels.chat({ roomId: '1' }), snapshot, { message: (ms, m) => [...ms, m] })
  state satisfies Message[]
  useChannelState(channels.chat({ roomId: '1' }), snapshot, {
    // @ts-expect-error reducer must return Message[]
    message: (ms, m) => m.text,
  })

  const [messages, { apply }] = useLive(live, { message: (ms, m) => [...ms, m], typing: (ms) => ms })
  messages satisfies Message[]
  apply('message', messages[0]!)
  // @ts-expect-error wrong payload for apply
  apply('message', { nope: true })
  // @ts-expect-error unknown event
  apply('nope', {})
  useLive(live, {
    // @ts-expect-error unknown event
    nope: (ms: Message[]) => ms,
  })
}

import { upsertBy } from '@/lib/next-sse/client'

export function upsertInference(snapshot: { data: Message[]; cursor: string }) {
  // property-key spelling: M inferred from the reducer context, wrong keys refused
  useChannelState(channels.chat({ roomId: '1' }), snapshot, { message: upsertBy('id') })
  useChannelState(channels.chat({ roomId: '1' }), snapshot, {
    // @ts-expect-error 'nope' is not a key of Message
    message: upsertBy('nope'),
  })
  // callback spelling: works with an explicit parameter type
  useChannelState(channels.chat({ roomId: '1' }), snapshot, { message: upsertBy((m: Message) => m.id) })
  // callback spelling withOUT annotation: contextual inference reaches the lambda (m: Message)…
  useChannelState(channels.chat({ roomId: '1' }), snapshot, { message: upsertBy((m) => m.id) })
  useChannelState(channels.chat({ roomId: '1' }), snapshot, {
    // @ts-expect-error …and it is really Message, not any: unknown properties are refused
    message: upsertBy((m) => m.nope),
  })
}

export function applyOnB(snapshot: { data: Message[]; cursor: string }) {
  const { apply } = useChannelState(channels.chat({ roomId: '1' }), snapshot, { message: upsertBy('id') })
  apply('message', { id: '1', roomId: '1', author: 'a', text: 'hi', at: 1 })
  // @ts-expect-error wrong payload for apply
  apply('message', { nope: true })
  // @ts-expect-error unknown event
  apply('nope', {})
}

export function actOnB(snapshot: { data: Message[]; cursor: string }) {
  const { act, pending, inFlight } = useChannelState(channels.chat({ roomId: '1' }), snapshot, { message: upsertBy('id') })
  const m: Message = { id: '1', roomId: '1', author: 'a', text: 'hi', at: 1 }
  act('message', m, async () => m)
  act('message', null, async () => m)
  pending.message satisfies Message[]
  pending.typing satisfies { author: string }[]
  inFlight satisfies boolean
  // @ts-expect-error the action must return the event's payload
  act('message', m, async () => 42)
  // @ts-expect-error wrong optimistic payload
  act('message', { nope: true }, async () => m)
  // @ts-expect-error unknown event
  act('nope', null, async () => m)
}
