// PROTOTYPE, variant D. Call sites, then what must NOT compile.
import { initSSE } from '../../lib/d/server.ts'
import { asType } from '../../lib/standard-schema.ts'
import { channels, useChannel } from './channels.client.ts'
import { announcements, chat, notifications, sse } from './channels.server.ts'

// ---- server side ----

export async function postMessage(roomId: string, text: string, author: string) {
  return sse.publish(chat({ roomId }), 'message', { id: crypto.randomUUID(), text, author })
}

export async function notify(userId: string, title: string) {
  return sse.publish(notifications({ userId }), 'notification', { id: crypto.randomUUID(), title })
}

export async function announce(text: string) {
  return sse.publish(announcements(), 'announcement', { text })
}

// ---- client side: handles come from the Proxy registry, keyed like the server registry ----

export function ChatRoom({ roomId, userId }: { roomId: string; userId: string }) {
  useChannel(channels.chat({ roomId }), {
    message: (m) => m.text.toUpperCase(), // m: { id: string; text: string; author: string }
    typing: (t) => t.userId,
  })
  useChannel(channels.notifications({ userId }), { notification: (n) => n.title })
  useChannel(channels.announcements(), { announcement: (a) => a.text })
}

// ---- what does NOT compile (wrapped in a function the demo never calls) ----
export function doesNotCompile() {

// @ts-expect-error roomId is required
channels.chat({})
// @ts-expect-error unknown param
chat({ room: '1' })
// @ts-expect-error a broadcast Channel takes no params
channels.announcements({ x: '1' })
// @ts-expect-error no such Channel in the registry
channels.rogue()

// @ts-expect-error unknown event name
void sse.publish(chat({ roomId: '1' }), 'mesage', { id: '1', text: 'hi', author: 'u7' })
// @ts-expect-error payload of the wrong event
void sse.publish(chat({ roomId: '1' }), 'typing', { text: 'hi' })

useChannel(channels.chat({ roomId: '1' }), {
  // @ts-expect-error unknown event name
  nope: () => {},
})
useChannel(channels.chat({ roomId: '1' }), {
  // @ts-expect-error payload is the zod Output type, text is a string
  message: (m) => m.text.toFixed(),
})
// @ts-expect-error a server handle is not a client handle (the client never sees names)
useChannel(chat({ roomId: '1' }), {})

const { channel } = initSSE({ context: () => ({ role: 'admin' as const }) })
// @ts-expect-error authorize is required: a Channel without one does not exist
channel({ pattern: 'x', events: { e: asType<{}>() } })
channel({
  pattern: 'x:{id}',
  events: { e: asType<{}>() },
  // @ts-expect-error ctx is typed from initSSE({ context }): no 'user' here
  authorize: ({ id }, { user }) => id === user,
})
}
