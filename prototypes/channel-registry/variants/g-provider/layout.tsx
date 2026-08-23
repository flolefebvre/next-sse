// PROTOTYPE, variant G. app/layout.tsx in the App: a Server Component mounts the provider once.
// `sse` is a server-only value; only the allowlisted data ({ key: { pattern, events } }) enters the RSC payload.
import type { ReactNode } from 'react'
import { SSEProvider } from '../../lib/g/provider.ts'
import { sse } from './sse.ts'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>
        <SSEProvider sse={sse}>{children}</SSEProvider>
      </body>
    </html>
  )
}
