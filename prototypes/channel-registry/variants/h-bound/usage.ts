// PROTOTYPE, variant H. Server call sites in both spellings, then what must NOT compile.
import { createClient } from '../../lib/h/client.ts'
import { initSSE, toClientChannels } from '../../lib/h/server.ts'
import { asType } from '../../lib/standard-schema.ts'
import { announcements, chat, notifications, sse } from './sse.ts'

// H-server-1: instance.publish(event, payload)
export async function postMessage(roomId: string, text: string, author: string) {
  return chat({ roomId }).publish('message', { id: crypto.randomUUID(), text, author })
}
export async function notify(userId: string, title: string) {
  return notifications({ userId }).publish('notification', { id: crypto.randomUUID(), title })
}

// H-server-2: instance.<event>(payload)
export async function postMessage2(roomId: string, text: string, author: string) {
  return chat({ roomId }).message({ id: crypto.randomUUID(), text, author })
}
export async function typing(roomId: string, userId: string) {
  return sse.chat({ roomId }).typing({ userId }) // via sse.* without the destructuring sugar
}
export async function announce(text: string) {
  return announcements().announcement({ text })
}

export const demoClient = createClient<typeof sse>(() => toClientChannels(sse))

// ---- what does NOT compile (wrapped in a function the demo never calls) ----
export function doesNotCompile() {
  const { channels, useChannel } = demoClient
  // @ts-expect-error roomId is required
  chat({})
  // @ts-expect-error unknown event name
  void chat({ roomId: '1' }).publish('mesage', { id: '1', text: 'hi', author: 'u7' })
  // @ts-expect-error wrong payload for typing
  void chat({ roomId: '1' }).typing({ text: 'hi' })
  // @ts-expect-error no such event method
  void chat({ roomId: '1' }).mesage({})
  // @ts-expect-error no such Channel
  sse.rogue()

  // @ts-expect-error roomId is required
  channels.useChat({}, {})
  channels.useChat({ roomId: '1' }, {
    // @ts-expect-error unknown event name
    nope: () => {},
  })
  // @ts-expect-error no such Channel
  channels.useRogue({}, {})
  useChannel(channels.chat({ roomId: '1' }), {
    // @ts-expect-error payload is the zod Output type
    message: (m) => m.text.toFixed(),
  })

  const { channel, createSSE } = initSSE({ context: () => ({}) })
  channel({
    pattern: 'x',
    // @ts-expect-error 'publish' is a reserved event name (it would shadow instance.publish)
    events: { publish: asType<{}>() },
    authorize: () => true,
  })
  // @ts-expect-error 'connect' is a reserved registry key
  createSSE({ connect: channel({ pattern: 'x', events: {}, authorize: () => true }) })
}
