'use client'
// PROTOTYPE, variant G. A Client Component. Same call sites as D/E; useChannel also returns the resolved name.
import { channels, useChannel } from './sse.client.ts'

export function ChatRoom({ roomId, userId }: { roomId: string; userId: string }) {
  const { name } = useChannel(channels.chat({ roomId }), {
    message: (m) => m.text.toUpperCase(), // m: { id: string; text: string; author: string }
    typing: (t) => t.userId,
  })
  useChannel(channels.notifications({ userId }), { notification: (n) => n.title })
  useChannel(channels.announcements(), { announcement: (a) => a.text })
  return <div data-channel={name} />
}
