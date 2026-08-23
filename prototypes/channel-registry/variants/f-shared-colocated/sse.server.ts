// PROTOTYPE, variant F. lib/sse.server.ts in the App: SERVER-ONLY and tiny. `context` is where server
// capabilities are exposed to authorize (a user, and whatever lookups the Channels need).
// import 'server-only'
import { createSSE } from '../../lib/f/server.ts'
import { getSession, isMember } from '../fake-app.ts'
import { channels } from './channels.ts'

export async function context(request: Request) {
  const user = await getSession(request)
  return { user, isMember: (roomId: string) => isMember(user.id, roomId) }
}
export type Ctx = Awaited<ReturnType<typeof context>>

export const sse = createSSE({ context, channels })
