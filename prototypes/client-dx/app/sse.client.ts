// lib/sse.client.ts in a real App: two lines, `import type` only, the server module never reaches the bundle.
import { createClient } from '@/lib/next-sse/client'
import type { sse } from './sse'

export const { channels, useChannel, useChannelState, useLive, useCoreTrace } = createClient<typeof sse>()
export type { Status } from '@/lib/next-sse/client'
