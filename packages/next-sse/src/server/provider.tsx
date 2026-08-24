import type { ReactNode } from "react";

import { SSEClientProvider } from "../client/index.js";

import { toClientChannels } from "./client-channels.js";
import type { RegistryLike } from "./registry.js";

export interface SSEProviderProps {
  /** The App's Registry, imported here — a Server Component — and nowhere below. */
  sse: RegistryLike;
  /** The SSE route this App serves, if it is not `/api/sse`. */
  url?: string;
  children?: ReactNode;
}

/**
 * Mount this once, in a layout, and every Client Component below can subscribe.
 *
 * It is a Server Component, and that is the whole mechanism (ADR-0002): it is the only place
 * the Registry module is imported, it strips it to the Channel allowlist, and it passes that
 * across the boundary as data. Next.js 16.3 has no supported way to extract values from a
 * server module into a client bundle, so the values travel as a prop instead — which fails
 * closed, and is bundler-independent.
 *
 * It takes no callback, because a Server Component cannot be given one. An App that needs to
 * override behaviour composes `SSEClientProvider` from `./client` itself.
 */
export function SSEProvider({ sse, url, children }: SSEProviderProps) {
  return (
    <SSEClientProvider channels={toClientChannels(sse)} url={url}>
      {children}
    </SSEClientProvider>
  );
}
