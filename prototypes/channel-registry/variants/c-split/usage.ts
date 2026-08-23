// PROTOTYPE, variant C. What App code looks like at the call sites, then what must NOT compile.
import { defineChannel } from '../../lib/c/define-channel.ts'
import { useChannel } from '../../lib/c/client.ts'
import { createSSE } from '../../lib/c/server.ts'
import { asType } from '../../lib/standard-schema.ts'
import { announcements, chat, notifications } from './channels.ts'
import { sse } from './channels.server.ts'

// ---- server side: a Server Action, a route handler, a cron, anything that runs on an Instance ----

export async function postMessage(roomId: string, text: string, author: string) {
  return sse.publish(chat({ roomId }), 'message', { id: crypto.randomUUID(), text, author })
}

export async function notify(userId: string, title: string) {
  return sse.publish(notifications({ userId }), 'notification', { id: crypto.randomUUID(), title })
}

export async function announce(text: string) {
  return sse.publish(announcements(), 'announcement', { text })
}

// ---- client side: a Client Component ('use client'), roomId / userId come from props or the URL ----

export function ChatRoom({ roomId, userId }: { roomId: string; userId: string }) {
  useChannel(chat({ roomId }), {
    message: (m) => m.text.toUpperCase(), // m: { id: string; text: string; author: string } (zod Output)
    typing: (t) => t.userId,
  })
  useChannel(notifications({ userId }), { notification: (n) => n.title })
  useChannel(announcements(), { announcement: (a) => a.text })
}

// ---- what does NOT compile (wrapped in a function the demo never calls) ----
export function doesNotCompile() {

// @ts-expect-error roomId is required
chat({})
// @ts-expect-error unknown param
chat({ room: '1' })
// @ts-expect-error a broadcast Channel takes no params
announcements({ x: '1' })

// @ts-expect-error unknown event name
void sse.publish(chat({ roomId: '1' }), 'mesage', { id: '1', text: 'hi', author: 'u7' })
// @ts-expect-error payload of the wrong event
void sse.publish(chat({ roomId: '1' }), 'typing', { text: 'hi' })
// @ts-expect-error missing field
void sse.publish(notifications({ userId: '1' }), 'notification', { id: '1' })

const rogue = defineChannel({ pattern: 'rogue', events: { e: asType<{ n: number }>() } })
// @ts-expect-error rogue is not registered in createSSE
void sse.publish(rogue(), 'e', { n: 1 })

useChannel(chat({ roomId: '1' }), {
  // @ts-expect-error unknown event name
  nope: () => {},
})
useChannel(chat({ roomId: '1' }), {
  // @ts-expect-error payload is the zod Output type, text is a string
  message: (m) => m.text.toFixed(),
})

void createSSE({
  context: () => ({}),
  channels: { chat, notifications },
  // @ts-expect-error forgot authorize for notifications
  authorize: { chat: () => true },
})
void createSSE({
  context: () => ({}),
  channels: { chat },
  // @ts-expect-error 'nope' is not a param of 'chat:{roomId}'
  authorize: { chat: ({ nope }) => nope === '1' },
})
}
