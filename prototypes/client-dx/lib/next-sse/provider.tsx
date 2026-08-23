// PROTOTYPE. The library's Server Component (ADR-0002): strips the Registry to `{ key: { pattern, events } }`
// and hands it to the 'use client' half as a prop. Mounted once in the root layout.
import type { ReactNode } from 'react'
import { SSEClientProvider } from './client-provider.tsx'
import { toClientChannels, type AnyBoundChannel } from './server.ts'

export function SSEProvider({ sse, children }: { sse: { channels: Record<string, AnyBoundChannel<any>> }; children?: ReactNode }) {
  return <SSEClientProvider channels={toClientChannels(sse)}>{children}</SSEClientProvider>
}
