// lib/sse.ts in a real App: the one server-only Registry (ADR-0002). Unchanged from the #8 prototype except
// `key` (ADR-0003) and a short heartbeat so the watchdog can be watched.
import 'server-only'
import { z } from 'zod'
import { initSSE } from '@/lib/next-sse/server'
import { userFromRequest } from './user'

const { channel, createSSE } = initSSE({
  context: async (request) => ({ user: userFromRequest(request) }),
  key: ({ user }) => user,
  heartbeat: 5000,
})

export const sse = createSSE({
  chat: channel({
    pattern: 'chat:{roomId}',
    events: {
      message: z.object({ id: z.string(), roomId: z.string(), author: z.string(), text: z.string().trim().min(1), at: z.number() }),
      typing: z.object({ author: z.string() }),
    },
    authorize: ({ roomId }, { user }) => roomId !== 'secret' || user === 'admin',
  }),
})

export const { chat } = sse
