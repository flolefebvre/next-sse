// PROTOTYPE. The Memory Transport, cut down: one ordered log per App on a globalThis symbol (ADR-0004),
// Cursor = `<epoch>-<seq>`, `gone` iff the Cursor is from another epoch, beyond the tail, or evicted (ADR-0006).
export interface Entry {
  id: string
  type: 'message' | 'control'
  channel: string
  event: string
  payload: unknown
  key?: string
}

export interface Connection {
  id: number
  channels: Set<string>
  key?: string
  deliver(entry: Entry): void
  close(reconnect: boolean): void
}

interface Log {
  epoch: number
  seq: number
  maxDeletedSeq: number
  cap: number
  entries: Entry[]
  connections: Set<Connection>
  nextConnectionId: number
}

const SLOT = Symbol.for('@flefebvre/next-sse/prototype-log')
const g = globalThis as unknown as Record<symbol, Log | undefined>

export function log(): Log {
  g[SLOT] ??= { epoch: Date.now(), seq: 0, maxDeletedSeq: 0, cap: 40, entries: [], connections: new Set(), nextConnectionId: 1 }
  return g[SLOT]!
}

export function tail(): string {
  const l = log()
  return `${l.epoch}-${l.seq}`
}

export function append(entry: Omit<Entry, 'id'>): Entry {
  const l = log()
  const stored: Entry = { ...entry, id: `${l.epoch}-${++l.seq}` }
  l.entries.push(stored)
  while (l.entries.length > l.cap) {
    const evicted = l.entries.shift()!
    l.maxDeletedSeq = Number(evicted.id.split('-')[1])
  }
  for (const c of l.connections) c.deliver(stored)
  return stored
}

export function readAfter(cursor: string): { entries: Entry[] } | { gone: true } {
  const l = log()
  const [epoch, seq] = cursor.split('-').map(Number)
  if (epoch !== l.epoch || !Number.isFinite(seq) || seq! > l.seq || seq! < l.maxDeletedSeq) return { gone: true }
  return { entries: l.entries.filter((e) => Number(e.id.split('-')[1]) > seq!) }
}

// ---- levers for the debug panel, nothing a real Transport exposes ----
export const debug = {
  dropConnections() {
    for (const c of log().connections) c.close(false)
  },
  evict() {
    const l = log()
    l.maxDeletedSeq = l.seq
    l.entries = []
  },
  restart() {
    const l = log()
    l.epoch = Date.now()
    l.seq = 0
    l.maxDeletedSeq = 0
    l.entries = []
    for (const c of l.connections) c.close(false)
  },
  stats() {
    const l = log()
    return { tail: tail(), retained: l.entries.length, cap: l.cap, connections: [...l.connections].map((c) => ({ id: c.id, key: c.key, channels: [...c.channels] })) }
  },
}
