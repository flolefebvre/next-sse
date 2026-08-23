// PROTOTYPE, variant F. lib/channels.ts in the App: SHARED by server and client, authorize colocated.
// The only server-side thing here is a *type*: `import type` is erased, so the client bundle gets patterns,
// schemas and the authorize functions' code, but no session/DB module. authorize can only use (params, ctx).
import { z } from 'zod'
import { channelWith } from '../../lib/f/server.ts'
import { asType } from '../../lib/standard-schema.ts'
import type { Ctx } from './sse.server.ts'

const channel = channelWith<Ctx>()

export const channels = {
  chat: channel({
    pattern: 'chat:{roomId}',
    events: {
      message: z.object({ id: z.string(), text: z.string().trim().min(1), author: z.string() }),
      typing: z.object({ userId: z.string() }),
    },
    authorize: ({ roomId }, ctx) => ctx.isMember(roomId),
  }),
  notifications: channel({
    pattern: 'user:{userId}:notifications',
    events: { notification: z.object({ id: z.string(), title: z.string() }) },
    authorize: ({ userId }, ctx) => ctx.user.id === userId,
  }),
  announcements: channel({
    pattern: 'announcements',
    events: { announcement: asType<{ text: string }>() },
    authorize: () => true,
  }),
}

export const { chat, notifications, announcements } = channels
