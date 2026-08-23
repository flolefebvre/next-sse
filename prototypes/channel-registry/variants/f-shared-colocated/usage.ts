// PROTOTYPE, variant F. Call sites are exactly C's: the client imports the shared values.
import { useChannel } from '../../lib/c/client.ts'
import { channelWith } from '../../lib/f/server.ts'
import { asType } from '../../lib/standard-schema.ts'
import { announcements, chat, notifications } from './channels.ts'
import { sse, type Ctx } from './sse.server.ts'

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

// ---- client side ----

export function ChatRoom({ roomId, userId }: { roomId: string; userId: string }) {
  useChannel(chat({ roomId }), {
    message: (m) => m.text.toUpperCase(),
    typing: (t) => t.userId,
  })
  useChannel(notifications({ userId }), { notification: (n) => n.title })
  useChannel(announcements(), { announcement: (a) => a.text })
}

// ---- what does NOT compile (wrapped in a function the demo never calls) ----
export function doesNotCompile() {
  // @ts-expect-error roomId is required
  chat({})
  // @ts-expect-error unknown event name
  void sse.publish(chat({ roomId: '1' }), 'mesage', { id: '1', text: 'hi', author: 'u7' })
  useChannel(chat({ roomId: '1' }), {
    // @ts-expect-error payload is the zod Output type
    message: (m) => m.text.toFixed(),
  })

  channelWith<Ctx>()({
    pattern: 'x:{id}',
    events: { e: asType<{}>() },
    // @ts-expect-error authorize only sees what context() exposes: no db here
    authorize: ({ id }, ctx) => ctx.db.has(id),
  })
}
