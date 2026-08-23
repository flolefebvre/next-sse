// PROTOTYPE, variant E. lib/sse.client.ts in the App. The patterns are restated here, once, and checked by the
// compiler against the server registry (see usage.ts): the client can then build real Channel names.
import { createClient } from '../../lib/e/client.ts'
import type { sse } from './channels.server.ts'

export const { channels, useChannel } = createClient<typeof sse>({
  chat: 'chat:{roomId}',
  notifications: 'user:{userId}:notifications',
  announcements: 'announcements',
})
