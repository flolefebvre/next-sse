"use client";

import { createClient } from "@flefebvre/next-sse/client";

import type { sse } from "./sse";

/**
 * The client's half of the Registry, and the one place an App writes it.
 *
 * The Registry is brought in with `import type`, so nothing of it — not Authorize, not the
 * Transport, not whatever a real App's Authorize imports — exists after the compiler has run.
 * What is left is types. The Channel names themselves come from `<SSEProvider>` at render
 * time, as data.
 */
export const { channels, useChannel, useChannelState } = createClient<typeof sse>();
