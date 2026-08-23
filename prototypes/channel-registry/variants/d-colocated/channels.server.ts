// PROTOTYPE, variant D. lib/sse.server.ts in the App: ONE server-only file holds the whole registry,
// Authorize colocated with each Channel. initSSE({ context }) fixes the ctx type for every authorize below.
// import 'server-only'
import { z } from 'zod'
import { initSSE } from '../../lib/d/server.ts'
import { asType } from '../../lib/standard-schema.ts'
import { getSession, isMember } from '../fake-app.ts'

const { channel, createSSE } = initSSE({
  context: async (request) => ({ user: await getSession(request) }),
})

export const sse = createSSE({
  // per-entity convention
  chat: channel({
    pattern: 'chat:{roomId}',
    events: {
      message: z.object({ id: z.string(), text: z.string().trim().min(1), author: z.string() }),
      typing: z.object({ userId: z.string() }),
    },
    authorize: ({ roomId }, { user }) => isMember(user.id, roomId),
  }),

  // per-user convention
  notifications: channel({
    pattern: 'user:{userId}:notifications',
    events: { notification: z.object({ id: z.string(), title: z.string() }) },
    authorize: ({ userId }, { user }) => user.id === userId,
  }),

  // broadcast convention, types-only payload
  announcements: channel({
    pattern: 'announcements',
    events: { announcement: asType<{ text: string }>() },
    authorize: () => true,
  }),
})

// Server-side handles, so publishers write `chat({ roomId })` rather than `sse.channels.chat({ roomId })`.
export const { chat, notifications, announcements } = sse.channels

// app/api/sse/route.ts in the App:
//   export const { GET } = sse.handlers
