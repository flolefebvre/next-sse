// PROTOTYPE, variant G. lib/sse.client.ts in the App: two lines, never changes when Channels are added.
// `import type` is erased; handles are typed from the server registry, patterns arrive via <SSEProvider>.
import { createClient } from '../../lib/g/client.ts'
import type { sse } from './sse.ts'

export const { channels, useChannel } = createClient<typeof sse>()
