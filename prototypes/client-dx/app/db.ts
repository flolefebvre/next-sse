// PROTOTYPE. A fake database: messages per room, in memory, with a deliberately slow read so the window between
// the server component's read and the Connection going live is wide enough to see.
export interface Message {
  id: string
  roomId: string
  author: string
  text: string
  at: number
}

const SLOT = Symbol.for('prototype-client-dx/db')
const g = globalThis as unknown as Record<symbol, Map<string, Message[]> | undefined>
const rooms = (g[SLOT] ??= new Map())

const seed = (roomId: string) => {
  if (!rooms.has(roomId))
    rooms.set(roomId, [
      { id: crypto.randomUUID(), roomId, author: 'system', text: `Welcome to #${roomId}`, at: Date.now() - 60_000 },
      { id: crypto.randomUUID(), roomId, author: 'ada', text: 'Anyone around?', at: Date.now() - 30_000 },
    ])
  return rooms.get(roomId)!
}

export const db = {
  async listMessages(roomId: string): Promise<Message[]> {
    await new Promise((r) => setTimeout(r, 800))
    return [...seed(roomId)]
  },
  async insertMessage(roomId: string, author: string, text: string): Promise<Message> {
    const message: Message = { id: crypto.randomUUID(), roomId, author, text, at: Date.now() }
    seed(roomId).push(message)
    return message
  },
}
