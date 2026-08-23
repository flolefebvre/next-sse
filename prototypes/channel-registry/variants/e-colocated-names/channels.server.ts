// PROTOTYPE, variant E. lib/sse.server.ts in the App: same single server-only registry as D.
// import 'server-only'
import { z } from 'zod'
import { initSSE } from '../../lib/e/server.ts'
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
