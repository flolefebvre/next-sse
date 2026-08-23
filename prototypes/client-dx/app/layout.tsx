// app/layout.tsx in a real App: `<SSEProvider sse={sse}>` once, around everything (ADR-0002).
import type { ReactNode } from 'react'
import Link from 'next/link'
import { SSEProvider } from '@/lib/next-sse/provider'
import { setName } from './actions'
import { sse } from './sse'
import { currentUser } from './user'
import { DebugPanel } from './debug-panel'
import './globals.css'

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser()
  return (
    <html lang="en">
      <body>
        <SSEProvider sse={sse}>
          <header>
            <Link href="/">next-sse · client DX prototype</Link>
            <nav>
              <Link href="/chat/general">#general</Link>
              <Link href="/chat/random">#random</Link>
              <Link href="/chat/secret">#secret (admin only)</Link>
            </nav>
            <form action={setName}>
              <input name="name" defaultValue={user} size={10} /> <button>I am</button>
            </form>
          </header>
          <main>{children}</main>
          <DebugPanel />
        </SSEProvider>
      </body>
    </html>
  )
}
