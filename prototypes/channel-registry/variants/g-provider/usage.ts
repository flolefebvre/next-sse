// PROTOTYPE, variant G. Server call sites, then what must NOT compile. (Client call sites: chat-room.tsx.)
import { createClient } from '../../lib/g/client.ts'
import { toClientChannels } from '../../lib/g/server.ts'
import { announcements, chat, notifications, sse } from './sse.ts'

export async function postMessage(roomId: string, text: string, author: string) {
  return sse.publish(chat({ roomId }), 'message', { id: crypto.randomUUID(), text, author })
}

export async function notify(userId: string, title: string) {
  return sse.publish(notifications({ userId }), 'notification', { id: crypto.randomUUID(), title })
}

export async function announce(text: string) {
  return sse.publish(announcements(), 'announcement', { text })
}

/** For the node demo: a client whose "context" is the data the provider would have passed down. */
export const demoClient = createClient<typeof sse>(() => toClientChannels(sse))

// ---- what does NOT compile (wrapped in a function the demo never calls) ----
export function doesNotCompile() {
  const { channels, useChannel } = demoClient
  // @ts-expect-error roomId is required
  channels.chat({})
  // @ts-expect-error a broadcast Channel takes no params
  channels.announcements({ x: '1' })
  // @ts-expect-error no such Channel in the registry
  channels.rogue()
  // @ts-expect-error unknown event name
  void sse.publish(chat({ roomId: '1' }), 'mesage', { id: '1', text: 'hi', author: 'u7' })
  useChannel(channels.chat({ roomId: '1' }), {
    // @ts-expect-error unknown event name
    nope: () => {},
  })
  useChannel(channels.chat({ roomId: '1' }), {
    // @ts-expect-error payload is the zod Output type
    message: (m) => m.text.toFixed(),
  })
  // @ts-expect-error a server handle is not a client handle
  useChannel(chat({ roomId: '1' }), {})
}
