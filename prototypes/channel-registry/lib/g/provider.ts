// PROTOTYPE, variant G. The library's Server Component: takes the App's `sse` (server-only value), strips it
// to the allowlist and hands the result to the 'use client' provider as a PROP, i.e. through the RSC payload.
// The App's colocated module is never imported by a Client Component, so server-only, db, sessions stay put.
import { createElement, type ReactNode } from 'react'
import { SSEClientProvider } from './client-provider.ts'
import { toClientChannels } from './server.ts'
import type { AnyServerChannel, SSE } from '../e/server.ts'

export function SSEProvider({ sse, children }: { sse: SSE<Record<string, AnyServerChannel<any>>, any>; children?: ReactNode }) {
  return createElement(SSEClientProvider, { channels: toClientChannels(sse) }, children)
}
