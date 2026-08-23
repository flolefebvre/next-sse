// PROTOTYPE, variant H. lib/sse.client.ts in the App: unchanged from G.
import { createClient } from '../../lib/h/client.ts'
import type { sse } from './sse.ts'

export const { channels, useChannel } = createClient<typeof sse>()
