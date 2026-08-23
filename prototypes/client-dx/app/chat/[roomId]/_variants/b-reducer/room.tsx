// VARIANT B, server component. `sse.snapshot(read)` takes the Cursor before running your read and returns both
// as one value; you cannot get the order wrong. Nothing else: no key, no refresh wiring.
import { db } from '@/app/db'
import { sse } from '@/app/sse'
import { ChatRoom } from './chat-room'

export async function RoomB({ roomId }: { roomId: string }) {
  const snapshot = await sse.snapshot(() => db.listMessages(roomId))
  return <ChatRoom roomId={roomId} snapshot={snapshot} />
}
