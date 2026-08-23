'use server'
// PROTOTYPE. Server actions: the real ones a chat App would have (post, typing) and the debug levers.
import { cookies } from 'next/headers'
import { db } from './db'
import { chat, sse } from './sse'
import { currentUser } from './user'
import { debug } from '@/lib/next-sse/log'

export async function postMessage(roomId: string, text: string) {
  const message = await db.insertMessage(roomId, await currentUser(), text)
  await chat({ roomId }).message(message)
  return message
}

export async function typing(roomId: string) {
  await chat({ roomId }).typing({ author: await currentUser() })
}

export async function setName(formData: FormData) {
  ;(await cookies()).set('name', String(formData.get('name') || 'guest'))
}

// ---- debug levers, not part of any API ----
export async function publishFromElsewhere(roomId: string, count = 1) {
  for (let i = 1; i <= count; i++) await postMessageAs(roomId, 'bot', `out-of-band message ${i}/${count}`)
}
async function postMessageAs(roomId: string, author: string, text: string) {
  await chat({ roomId }).message(await db.insertMessage(roomId, author, text))
}
export async function kickMe() {
  await sse.kick({ key: await currentUser() })
}
export async function kickRoom(roomId: string) {
  await sse.kick(chat({ roomId }))
}
export async function dropConnections() {
  debug.dropConnections()
}
export async function dropAndPublish(roomId: string) {
  debug.dropConnections()
  await publishFromElsewhere(roomId, 3)
}
export async function dropAndEvict(roomId: string) {
  // evicting a log whose last Entry IS the client's Cursor is not `gone` (nothing after it was lost):
  // publish two Messages the client will never see, then evict them, so its Cursor is older than max-deleted
  debug.dropConnections()
  await publishFromElsewhere(roomId, 2)
  debug.evict()
}
export async function restartServer() {
  debug.restart()
}
export async function stats() {
  return debug.stats()
}
