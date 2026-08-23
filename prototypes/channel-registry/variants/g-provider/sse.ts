// PROTOTYPE, variant G. lib/sse.ts in the App: THE one file. Server-only, never imported by a Client Component.
// import 'server-only'   ← stays; the build fails loudly if a Client Component ever imports this.
import { z } from 'zod'
import { initSSE } from '../../lib/g/server.ts'
import { asType } from '../../lib/standard-schema.ts'
import { getSession, isMember } from '../fake-app.ts'

const { channel, createSSE } = initSSE({
  context: async (request) => ({ user: await getSession(request) }),
})

export const sse = createSSE({
  chat: channel({
    pattern: 'chat:{roomId}',
    events: {
      message: z.object({ id: z.string(), text: z.string().trim().min(1), author: z.string() }),
      typing: z.object({ userId: z.string() }),
    },
    authorize: ({ roomId }, { user }) => isMember(user.id, roomId),
  }),
  notifications: channel({
    pattern: 'user:{userId}:notifications',
    events: { notification: z.object({ id: z.string(), title: z.string() }) },
    authorize: ({ userId }, { user }) => user.id === userId,
  }),
  announcements: channel({
    pattern: 'announcements',
    events: { announcement: asType<{ text: string }>() },
    authorize: () => true,
  }),
})

export const { chat, notifications, announcements } = sse.channels

// app/api/sse/route.ts:  export const { GET } = sse.handlers
