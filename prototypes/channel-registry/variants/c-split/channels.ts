// PROTOTYPE, variant C. lib/channels.ts in the App: SHARED by server and client.
// Only names, patterns and schemas live here, so a Client Component can import it (zod is browser-safe).
import { z } from 'zod'
import { defineChannel } from '../../lib/c/define-channel.ts'
import { asType } from '../../lib/standard-schema.ts'

// per-entity convention
export const chat = defineChannel({
  pattern: 'chat:{roomId}',
  events: {
    message: z.object({ id: z.string(), text: z.string().trim().min(1), author: z.string() }),
    typing: z.object({ userId: z.string() }),
  },
})

// per-user convention
export const notifications = defineChannel({
  pattern: 'user:{userId}:notifications',
  events: { notification: z.object({ id: z.string(), title: z.string() }) },
})

// broadcast convention, and a types-only payload (no validator at all)
export const announcements = defineChannel({
  pattern: 'announcements',
  events: { announcement: asType<{ text: string }>() },
})
