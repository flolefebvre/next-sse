// PROTOTYPE route: three variants of the same chat page, switchable via `?variant=a|b|c`. Read each variant as a pair:
// `_variants/<x>/room.tsx` (server component: load + Cursor handoff) and `chat-room.tsx` (client: the hook).
import { PrototypeSwitcher } from '@/app/prototype-switcher'
import { RoomA } from './_variants/a-handlers/room'
import { RoomB } from './_variants/b-reducer/room'
import { RoomC } from './_variants/c-snapshot/room'

const variants = [
  { key: 'a', name: 'useChannel: handlers, your state', Room: RoomA, server: 'sse.cursor() + prop + key={cursor}', client: 'useChannel(handle, handlers, { cursor, onReset })' },
  { key: 'b', name: 'useChannelState: snapshot + reducers', Room: RoomB, server: 'sse.snapshot(read) → { data, cursor }', client: 'useChannelState(handle, snapshot, reducers)' },
  { key: 'c', name: 'useLive: Handle-bound snapshot', Room: RoomC, server: 'chat({ roomId }).snapshot(read) → { channel, cursor, data }', client: 'useLive(snapshot, reducers)' },
]

export default async function Page({ params, searchParams }: { params: Promise<{ roomId: string }>; searchParams: Promise<{ variant?: string }> }) {
  const { roomId } = await params
  const { variant = 'a' } = await searchParams
  const v = variants.find((x) => x.key === variant) ?? variants[0]!
  return (
    <>
      <p className="variant">
        <b>{v.key.toUpperCase()}</b> · server <code>{v.server}</code> · client <code>{v.client}</code>
      </p>
      <v.Room roomId={roomId} />
      <PrototypeSwitcher variants={variants.map(({ key, name }) => ({ key, name }))} current={v.key} />
    </>
  )
}
