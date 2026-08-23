// PROTOTYPE, variant E. Call sites, then what must NOT compile.
import { createClient } from '../../lib/e/client.ts'
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

// ---- client side: channels.chat({ roomId }).name === 'chat:42', built on the client ----

export function ChatRoom({ roomId, userId }: { roomId: string; userId: string }) {
  useChannel(channels.chat({ roomId }), {
    message: (m) => m.text.toUpperCase(),
    typing: (t) => t.userId,
  })
  useChannel(channels.notifications({ userId }), { notification: (n) => n.title })
  useChannel(channels.announcements(), { announcement: (a) => a.text })
}

// ---- what does NOT compile (wrapped in a function the demo never calls) ----
export function doesNotCompile() {
  // @ts-expect-error roomId is required
  channels.chat({})
  // @ts-expect-error a broadcast Channel takes no params
  channels.announcements({ x: '1' })
  // @ts-expect-error unknown event name
  void sse.publish(chat({ roomId: '1' }), 'mesage', { id: '1', text: 'hi', author: 'u7' })
  useChannel(channels.chat({ roomId: '1' }), {
    // @ts-expect-error payload is the zod Output type
    message: (m) => m.text.toFixed(),
  })

  // the pattern map is checked against the server registry:
  createClient<typeof sse>({
    // @ts-expect-error pattern differs from the server's 'chat:{roomId}'
    chat: 'chat:{id}',
    notifications: 'user:{userId}:notifications',
    announcements: 'announcements',
  })
  // @ts-expect-error announcements is missing
  createClient<typeof sse>({ chat: 'chat:{roomId}', notifications: 'user:{userId}:notifications' })
  createClient<typeof sse>({
    chat: 'chat:{roomId}',
    notifications: 'user:{userId}:notifications',
    announcements: 'announcements',
    // @ts-expect-error no such Channel on the server
    rogue: 'rogue',
  })
}
