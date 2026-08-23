'use client'
// PROTOTYPE. Client half of the provider: holds the Channel allowlist and ONE Core for the whole tree.
// The provider's `onReset` is the App-wide default for a Reset: refetch everything (`router.refresh()` re-runs the
// server components, which take a fresh Cursor). A hook can override it.
import { createContext, useContext, useRef, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Core } from './core.ts'
import type { ClientChannels } from './server.ts'

interface SSEContextValue {
  channels: ClientChannels
  core: Core
  onReset: () => void
}
const SSEContext = createContext<SSEContextValue | null>(null)

export function SSEClientProvider({ channels, url = '/api/sse', onReset, children }: { channels: ClientChannels; url?: string; onReset?: () => void; children?: ReactNode }) {
  const router = useRouter()
  const core = useRef<Core | null>(null)
  core.current ??= new Core(url)
  return <SSEContext.Provider value={{ channels, core: core.current, onReset: onReset ?? (() => router.refresh()) }}>{children}</SSEContext.Provider>
}

export function useSSEContext(): SSEContextValue {
  const value = useContext(SSEContext)
  if (!value) throw new Error('next-sse: <SSEProvider> is missing above this component')
  return value
}
