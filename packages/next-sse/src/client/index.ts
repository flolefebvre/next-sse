"use client";

import { notImplemented } from "../internal/not-implemented.js";

export { createClient } from "./create-client.js";
export type { SSEClient } from "./create-client.js";
export type { ChannelOptions, Channels, ChannelSubscription, Handle, Handlers } from "./handle.js";
export { SSEClientProvider } from "./provider.js";
export type { ClientChannel, ClientChannels, SSEClientProviderProps } from "./provider.js";
export type { Status } from "./core.js";
export type { Snapshot } from "../internal/snapshot.js";

/**
 * The keyed-merge reducer that covers the Snapshot/replay overlap, Kick replay and the echo
 * of a server action alike.
 */
export function upsertBy(key?: unknown): never {
  void key;

  return notImplemented("upsertBy");
}
