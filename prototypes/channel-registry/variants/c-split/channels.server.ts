// PROTOTYPE, variant C. lib/channels.server.ts in the App: SERVER-ONLY.
// import 'server-only'   ← real App: Next.js fails the build if a Client Component imports this.
import { createSSE } from '../../lib/c/server.ts'
import { getSession, isMember } from '../fake-app.ts'
import { announcements, chat, notifications } from './channels.ts'

export const sse = createSSE({
  context: async (request) => ({ user: await getSession(request) }),
  channels: { chat, notifications, announcements },
  authorize: {
    chat: ({ roomId }, { user }) => isMember(user.id, roomId), // params typed from 'chat:{roomId}'
    notifications: ({ userId }, { user }) => user.id === userId,
    announcements: () => true,
  },
})

// app/api/sse/route.ts in the App:
//   export const { GET } = sse.handlers
