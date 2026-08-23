'use client'
// Shared, non-DX UI: the list and a live-only typing indicator (no Cursor: a second hook on the same Connection).
import { useEffect, useState } from 'react'
import type { Message } from '@/app/db'
import { channels, useChannel, type Status } from '@/app/sse.client'

export const upsert = (messages: Message[], m: Message) => (messages.some((x) => x.id === m.id) ? messages : [...messages, m])

export function MessageList({ messages, pending = [] }: { messages: Message[]; pending?: Message[] }) {
  return (
    <ul className="messages">
      {messages.map((m) => (
        <li key={m.id}><b>{m.author}</b> {m.text} <small>{m.id.slice(0, 8)}</small></li>
      ))}
      {pending.map((m) => (
        <li key={m.id} className="pending"><b>{m.author}</b> {m.text} <small>sending…</small></li>
      ))}
    </ul>
  )
}

export function StatusPill({ status }: { status: Status }) {
  return <span className={`status status-${status}`}>{status}</span>
}

export function TypingIndicator({ roomId }: { roomId: string }) {
  const [who, setWho] = useState<string | null>(null)
  // No cursor: live-only from the tail. Typing events from before this component mounted are not wanted.
  useChannel(channels.chat({ roomId }), { typing: ({ author }) => setWho(author) })
  useEffect(() => {
    if (!who) return
    const t = setTimeout(() => setWho(null), 2000)
    return () => clearTimeout(t)
  }, [who])
  return <p className="typing">{who ? `${who} is typing…` : ''}</p>
}
