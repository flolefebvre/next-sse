// VARIANT C, server component. The server Handle takes the snapshot: `chat({ roomId }).snapshot(read)` returns
// `{ channel, cursor, data }`, typed with the Channel's events. The client never builds a Handle: it receives one
// serialised value that says which Channel, from where, with what.
import { db } from '@/app/db'
import { chat } from '@/app/sse'
import { ChatRoom } from './chat-room'

export async function RoomC({ roomId }: { roomId: string }) {
  const live = await chat({ roomId }).snapshot(() => db.listMessages(roomId))
  return <ChatRoom roomId={roomId} live={live} />
}
