'use client'
// PROTOTYPE, variant H. Two client spellings on the same object: pick one.
import { channels, useChannel } from './sse.client.ts'

export function ChatRoomA({ roomId, userId }: { roomId: string; userId: string }) {
  // H-client-1: a handle plus the generic hook (as in G)
  const { name } = useChannel(channels.chat({ roomId }), {
    message: (m) => m.text.toUpperCase(),
    typing: (t) => t.userId,
  })
  useChannel(channels.notifications({ userId }), { notification: (n) => n.title })
  useChannel(channels.announcements(), { announcement: (a) => a.text })
  return <div data-channel={name} />
}

export function ChatRoomB({ roomId, userId }: { roomId: string; userId: string }) {
  // H-client-2: one generated hook per Channel
  const { name } = channels.useChat({ roomId }, {
    message: (m) => m.text.toUpperCase(),
    typing: (t) => t.userId,
  })
  channels.useNotifications({ userId }, { notification: (n) => n.title })
  channels.useAnnouncements({ announcement: (a) => a.text })
  return <div data-channel={name} />
}
