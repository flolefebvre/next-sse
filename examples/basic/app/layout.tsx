import { SSEProvider } from "@flefebvre/next-sse/server";
import type { ReactNode } from "react";

import { sse } from "@/lib/sse";

export const metadata = {
  title: "next-sse example",
  description: "The example app of @flefebvre/next-sse.",
};

/**
 * The Registry is imported here, in a Server Component, and nowhere below. `<SSEProvider>`
 * strips it to the Channel allowlist and passes that across the boundary as a prop, which is
 * how a Client Component addresses a Channel without importing server code. Mounted once, in
 * the root layout, it covers the whole App; `url` would go here if the route were not
 * `/api/sse`.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SSEProvider sse={sse}>{children}</SSEProvider>
      </body>
    </html>
  );
}
