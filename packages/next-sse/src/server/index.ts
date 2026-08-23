import { notImplemented } from "../internal/not-implemented.js";
import type { Transport } from "../transport/index.js";

import { getInstance } from "./instance.js";
import { channel, createSSE, type ChannelDeclaration, type Registry } from "./registry.js";

export type { ChannelDeclaration, Handle, Registry } from "./registry.js";

export interface InitOptions {
  /**
   * The log this App runs on. Omitted, the App gets the Memory Transport, which serves one
   * Instance; choosing the Transport from `REDIS_URL` is what the Redis Transport's own ticket
   * puts here. Every other option of ADR-0008 joins this type as the ticket that honours it
   * lands: an option that is declared but ignored is a promise the library does not keep.
   */
  transport?: Transport;
}

/**
 * The App's single entry into the library: it takes the Instance's configuration and returns
 * the two factories the App declares its Registry with.
 */
export function initSSE(options: InitOptions = {}): {
  channel: typeof channel;
  createSSE: (channels: Record<string, ChannelDeclaration>) => Registry;
} {
  const instance = getInstance(options);

  return {
    channel,
    createSSE: (channels) => createSSE(instance, channels),
  };
}

/**
 * The Server Component that shares the Registry's Channel data with the client tree.
 */
export function SSEProvider(props?: unknown): never {
  void props;

  return notImplemented("SSEProvider");
}

/**
 * The serialisable Channel data of a Registry, for an App that composes `SSEClientProvider`
 * itself rather than mounting `SSEProvider`.
 */
export function toClientChannels(sse?: unknown): never {
  void sse;

  return notImplemented("toClientChannels");
}
