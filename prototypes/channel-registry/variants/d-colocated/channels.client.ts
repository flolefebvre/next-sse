// PROTOTYPE, variant D. lib/sse.client.ts in the App. `import type` is erased by the compiler, so no zod,
// no pattern, no authorize and no session code ends up in the client bundle; only the types cross over.
import { createClient } from '../../lib/d/client.ts'
import type { sse } from './channels.server.ts'

export const { channels, useChannel } = createClient<typeof sse>()
