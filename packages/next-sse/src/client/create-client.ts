"use client";

import type { ChannelRecord, EventsOf } from "../internal/channel.js";

import type {
  ChannelOptions,
  Channels,
  ChannelsOf,
  ChannelSubscription,
  Handle,
  Handlers,
} from "./handle.js";
import { useChannel } from "./use-channel.js";

export interface SSEClient<Registry> {
  /** `channels.chat({ roomId })`: a Handle, built from nothing but its key and its params. */
  readonly channels: Channels<Registry>;
  /** Subscribe to a Channel for as long as the component is mounted. */
  useChannel<Key extends keyof ChannelsOf<Registry> & string>(
    handle: Handle<Key>,
    handlers: Handlers<EventsOf<ChannelsOf<Registry>[Key]>>,
    options?: ChannelOptions,
  ): ChannelSubscription;
}

/**
 * The client's entry: `createClient<typeof sse>()` in a `'use client'` module of the App, with
 * the Registry brought in by `import type` so no value of it crosses into the browser bundle.
 *
 * Everything the client is typed by comes through that one type argument: which Channels
 * exist, what params each pattern needs, and what each event's payload is. Nothing of the
 * Registry exists at runtime here — the Channel names themselves come from the provider's
 * data, at render time (ADR-0002).
 *
 * The hooks it hands back are the module's own, typed here and nowhere else: this function is
 * the seam where the App's Registry meets them, and it holds no state of its own.
 */
export function createClient<Registry extends { channels: ChannelRecord }>(): SSEClient<Registry> {
  const channels = new Proxy({} as Channels<Registry>, {
    get: (_, key) =>
      typeof key === "string"
        ? (params: Record<string, string> = {}) => ({ key, params })
        : undefined,
  });

  return { channels, useChannel };
}
