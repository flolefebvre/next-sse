// VARIANT A, server component. The handoff is explicit: take the Cursor, THEN read, pass both down.
// `key={cursor}`: a Reset makes the client call router.refresh(); this re-runs, mints a new Cursor, and the new key
// remounts the room with fresh `useState(initial)`. No effect syncing props into state.
import { db } from '@/app/db'
import { sse } from '@/app/sse'
import { ChatRoom } from './chat-room'

export async function RoomA({ roomId }: { roomId: string }) {
  const cursor = await sse.cursor()
  const messages = await db.listMessages(roomId)
  return <ChatRoom key={cursor} roomId={roomId} initial={messages} cursor={cursor} />
}
