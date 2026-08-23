// PROTOTYPE. Runs both variants through the same scenario and prints every intermediate state.
// `pnpm demo` (Node 24 strips the types natively).
import { subscriptions } from './lib/channel.ts'
import { PayloadError } from './lib/standard-schema.ts'
import * as C from './variants/c-split/channels.ts'
import { sse as sseC } from './variants/c-split/channels.server.ts'
import * as Cusage from './variants/c-split/usage.ts'
import * as D from './variants/d-colocated/channels.server.ts'
import * as Dusage from './variants/d-colocated/usage.ts'

const h = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`)
const row = (...cells: unknown[]) => console.log('  ' + cells.map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join('  '))
const asUser = (id: string) => new Request('http://app/api/sse', { headers: { 'x-user': id } })

async function publishes(sse: { publish: (...args: any[]) => Promise<unknown> }, chat: (p: { roomId: string }) => unknown, announcements: () => unknown) {
  h('Publish: validation happens here, the wire carries the schema Output')
  row('chat(42) message { text: "  hi  " }', '→', await sse.publish(chat({ roomId: '42' }), 'message', { id: 'm1', text: '  hi  ', author: 'u7' }), '(zod trimmed it: Input ≠ Output)')
  try {
    await sse.publish(chat({ roomId: '42' }), 'message', { id: 'm2', text: '   ', author: 'u7' })
  } catch (e) {
    row('chat(42) message { text: "   " }', '→ REJECTED', (e as PayloadError).issues.map((i) => i.message))
  }
  row('announcements() announcement { text: 123 } (types-only schema, caller cast to any)', '→', await sse.publish(announcements(), 'announcement', { text: 123 } as any), '(no validator: passes through)')
  try {
    await sse.publish(chat({ roomId: '42' }), 'nope' as any, {})
  } catch (e) {
    row('chat(42) "nope"', '→ REJECTED', (e as Error).message)
  }
}

function printSubscriptions(label: string) {
  h(`Client subscriptions recorded by useChannel (${label})`)
  subscriptions.splice(0).forEach((s) => row(s.name, 'events:', s.events))
}

// ───────────────────────────── Variant C ─────────────────────────────
console.log('\n══════════ Variant C: shared channels.ts + authorize map in createSSE (server-only) ══════════')

h('Instances: the typed handle that publish / useChannel / authorize agree on')
for (const i of [C.chat({ roomId: '42' }), C.notifications({ userId: 'u7' }), C.announcements()]) {
  row(i.pattern.padEnd(28), '→ name', i.name.padEnd(24), 'params', i.params, 'events', Object.keys(i.events))
}

h('Connect as u7 asking for names: the server parses each name against the registry, then authorizes')
const reqC = ['chat:42', 'chat:99', 'user:u7:notifications', 'user:u9:notifications', 'announcements', 'nope:1', 'chat:4:2']
const rC = await sseC.connect(asUser('u7'), reqC)
rC.channels.forEach((c) => row(c.name.padEnd(24), '→', (c.key ?? '(no pattern matches)').padEnd(22), c.params ?? '', c.status.toUpperCase()))
row('Connection:', rC.accepted ? 'ACCEPTED' : 'REFUSED (any denied or unknown Channel refuses the whole Connection)')
const rC2 = await sseC.connect(asUser('u7'), ['chat:42', 'user:u7:notifications', 'announcements'])
row('Connect again with only allowed names →', rC2.accepted ? 'ACCEPTED' : 'REFUSED')
row('GET /api/sse?channel=chat:42&channel=chat:99 as u7 →', (await sseC.handlers.GET(new Request('http://app/api/sse?channel=chat:42&channel=chat:99', { headers: { 'x-user': 'u7' } }))).status)

await publishes(sseC, C.chat, C.announcements)
Cusage.ChatRoom({ roomId: '42', userId: 'u7' })
printSubscriptions('names are built on the client from the shared pattern')

// ───────────────────────────── Variant D ─────────────────────────────
console.log('\n══════════ Variant D: one server-only registry with authorize colocated, type-only client ══════════')

h('Instances (server side)')
for (const i of [D.chat({ roomId: '42' }), D.notifications({ userId: 'u7' }), D.announcements()]) {
  row(i.pattern.padEnd(28), '→ name', i.name.padEnd(24), 'params', i.params, 'events', Object.keys(i.events))
}

h('Connect as u7 sending { key, params }: no name parsing, the server mints the name after authorizing')
const reqD: { key: string; params: Record<string, string> }[] = [
  { key: 'chat', params: { roomId: '42' } },
  { key: 'chat', params: { roomId: '99' } },
  { key: 'notifications', params: { userId: 'u7' } },
  { key: 'notifications', params: { userId: 'u9' } },
  { key: 'announcements', params: {} },
  { key: 'nope', params: { id: '1' } },
]
const rD = await D.sse.connect(asUser('u7'), reqD)
rD.channels.forEach((c) => row(c.key.padEnd(14), c.params, '→', (c.name ?? '(no such Channel)').padEnd(24), c.status.toUpperCase()))
row('Connection:', rD.accepted ? 'ACCEPTED' : 'REFUSED')
row('GET /api/sse?channels=[{"key":"chat","params":{"roomId":"42"}}] as u7 →', (await D.sse.handlers.GET(new Request('http://app/api/sse?channels=' + encodeURIComponent('[{"key":"chat","params":{"roomId":"42"}}]'), { headers: { 'x-user': 'u7' } }))).status)

await publishes(D.sse, D.chat, D.announcements)
Dusage.ChatRoom({ roomId: '42', userId: 'u7' })
printSubscriptions('the client only knows key + params; it never sees a Channel name')
console.log()
