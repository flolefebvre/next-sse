'use client'
// VARIANT A, client. `useChannel` only calls handlers; you own the state (useState) and the merge (upsert).
// Reset is yours too: `onReset` → router.refresh(). Reconnection is invisible except through `status`.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { postMessage, typing } from '@/app/actions'
import type { Message } from '@/app/db'
import { channels, useChannel } from '@/app/sse.client'
import { MessageList, StatusPill, TypingIndicator, upsert } from '../shared'

export function ChatRoom({ roomId, initial, cursor }: { roomId: string; initial: Message[]; cursor: string }) {
  const router = useRouter()
  const [messages, setMessages] = useState(initial)

  const { status } = useChannel(
    channels.chat({ roomId }),
    { message: (m) => setMessages((ms) => upsert(ms, m)) },
    { cursor, onReset: () => router.refresh() },
  )

  return (
    <>
      <h2>#{roomId} <StatusPill status={status} /></h2>
      <MessageList messages={messages} />
      <TypingIndicator roomId={roomId} />
      <form
        className="composer"
        action={async (form) => {
          await postMessage(roomId, String(form.get('text')))
        }}
      >
        <input name="text" placeholder="Say something" autoComplete="off" onChange={() => typing(roomId)} />
        <button>Send</button>
      </form>
    </>
  )
}
