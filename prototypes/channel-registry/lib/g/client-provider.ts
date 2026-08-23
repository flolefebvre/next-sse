'use client'
// PROTOTYPE, variant G. The library's client half: a React context holding the ClientChannels data. Written with
// createElement (no JSX) only so the node demo can import it; it is an ordinary 'use client' module.
import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { ClientChannels } from './server.ts'

const SSEContext = createContext<ClientChannels | null>(null)

export function SSEClientProvider({ channels, children }: { channels: ClientChannels; children?: ReactNode }) {
  return createElement(SSEContext.Provider, { value: channels }, children)
}

export function useClientChannels(): ClientChannels {
  const channels = useContext(SSEContext)
  if (!channels) throw new Error('next-sse: <SSEProvider> is missing above this component')
  return channels
}
