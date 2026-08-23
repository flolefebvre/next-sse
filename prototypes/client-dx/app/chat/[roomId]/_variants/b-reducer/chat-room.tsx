'use client'
// VARIANT B, client. The hook owns the state: seeded from `snapshot.data`, advanced by one reducer per event,
// restarted whenever a new snapshot arrives. Reset needs no code here: the provider's default is router.refresh(),
// which re-runs RoomB and hands this component a new snapshot. Sending is one `act` call: optimistic row while the
// action runs, its returned Message applied before the transition ends, the SSE echo absorbed by upsertBy.
import { postMessage, typing } from '@/app/actions'
import type { Message } from '@/app/db'
import { channels, useChannelState } from '@/app/sse.client'
import { upsertBy, type Snapshot } from '@/lib/next-sse/client'
import { MessageList, StatusPill, TypingIndicator } from '../shared'

export function ChatRoom({ roomId, snapshot }: { roomId: string; snapshot: Snapshot<Message[]> }) {
  const { state: messages, status, pending, act } = useChannelState(channels.chat({ roomId }), snapshot, {
    message: upsertBy('id'),
  })

  const send = (form: FormData) => {
    const text = String(form.get('text'))
    act('message', { id: `pending-${Date.now()}`, roomId, author: 'me', text, at: Date.now() }, () => postMessage(roomId, text))
  }

  return (
    <>
      <h2>#{roomId} <StatusPill status={status} /></h2>
      <MessageList messages={messages} pending={pending.message} />
      <TypingIndicator roomId={roomId} />
      <form className="composer" action={send}>
        <input name="text" placeholder="Say something" autoComplete="off" onChange={() => typing(roomId)} />
        <button>Send</button>
      </form>
    </>
  )
}
