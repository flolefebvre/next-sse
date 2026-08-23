'use client'
// VARIANT C, client. `useLive(snapshot, reducers)` → `[state, { status, apply }]`. The prop type is the only place
// the Registry is named (`SnapshotOf<typeof sse, 'chat', Message[]>`). `apply` runs a reducer locally, here with the
// server action's result so the sent message shows before the SSE echo lands (the echo is absorbed by upsert).
import { useOptimistic, useTransition } from 'react'
import { postMessage, typing } from '@/app/actions'
import type { Message } from '@/app/db'
import type { sse } from '@/app/sse'
import { useLive } from '@/app/sse.client'
import type { SnapshotOf } from '@/lib/next-sse/client'
import { MessageList, StatusPill, TypingIndicator, upsert } from '../shared'

export function ChatRoom({ roomId, live }: { roomId: string; live: SnapshotOf<typeof sse, 'chat', Message[]> }) {
  const [messages, { status, apply }] = useLive(live, {
    message: (messages, m) => upsert(messages, m),
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
