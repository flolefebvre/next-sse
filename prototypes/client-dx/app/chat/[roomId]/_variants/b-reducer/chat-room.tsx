'use client'
// VARIANT B, client. The hook owns the state: seeded from `snapshot.data`, advanced by one reducer per event,
// restarted whenever a new snapshot arrives. Reset needs no code here: the provider's default is router.refresh(),
// which re-runs RoomB and hands this component a new snapshot. Optimistic sends use React's useOptimistic, and
// `apply` upserts the action's result before the transition ends, so the SSE echo (a no-op) can't flicker.
import { useOptimistic, useTransition } from 'react'
import { postMessage, typing } from '@/app/actions'
import type { Message } from '@/app/db'
import { channels, useChannelState } from '@/app/sse.client'
import { upsertBy, type Snapshot } from '@/lib/next-sse/client'
import { MessageList, StatusPill, TypingIndicator } from '../shared'

export function ChatRoom({ roomId, snapshot }: { roomId: string; snapshot: Snapshot<Message[]> }) {
  const { state: messages, status, apply } = useChannelState(channels.chat({ roomId }), snapshot, {
    message: upsertBy('id'),
  })
  const [pending, addPending] = useOptimistic<Message[], Message>([], (list, m) => [...list, m])
  const [, start] = useTransition()

  const send = (form: FormData) =>
    start(async () => {
      const text = String(form.get('text'))
      addPending({ id: `pending-${Date.now()}`, roomId, author: 'me', text, at: Date.now() })
      apply('message', await postMessage(roomId, text))
    })

  return (
    <>
      <h2>#{roomId} <StatusPill status={status} /></h2>
      <MessageList messages={messages} pending={pending} />
      <TypingIndicator roomId={roomId} />
      <form className="composer" action={send}>
        <input name="text" placeholder="Say something" autoComplete="off" onChange={() => typing(roomId)} />
        <button>Send</button>
      </form>
    </>
  )
}
