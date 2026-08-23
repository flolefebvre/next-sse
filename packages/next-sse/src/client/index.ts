"use client";

import { notImplemented } from "../internal/not-implemented.js";

export { createClient } from "./create-client.js";
export type {
  ChannelSubscription,
  Channels,
  Handle,
  Handlers,
  SSEClient,
} from "./create-client.js";
export { SSEClientProvider } from "./provider.js";
export type { ClientChannel, ClientChannels, SSEClientProviderProps } from "./provider.js";
export type { Status } from "./core.js";

declare const snapshotBrand: unique symbol;

/**
 * The one value a server component hands the client to make server-rendered data live: the
 * data it read, and the Cursor taken just before that read. Opaque by construction (ADR-0007)
 * — only `sse.snapshot` mints one, and the client never sees the Cursor inside it.
 */
export type Snapshot<Data = unknown> = {
  readonly data: Data;
  readonly [snapshotBrand]: true;
};

/**
 * The keyed-merge reducer that covers the Snapshot/replay overlap, Kick replay and the echo
 * of a server action alike.
 */
export function upsertBy(key?: unknown): never {
  void key;

  return notImplemented("upsertBy");
}
