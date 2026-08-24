"use client";

import { cursorOf } from "../internal/snapshot.js";

import type { ChannelOptions, ChannelSubscription, Handle, Handlers } from "./handle.js";
import { useSubscription } from "./use-subscription.js";

/**
 * Subscribe to a Channel for as long as the component is mounted, and do something with each
 * Message it carries.
 *
 * This is the low-level hook (ADR-0007): the component owns whatever state it keeps, and the
 * hook only calls handlers. `useChannelState` is the shape a page usually wants — it owns the
 * state, seeds it from the Snapshot and absorbs the duplicates a replay brings.
 */
export function useChannel(
  handle: Handle,
  handlers: Handlers,
  { snapshot, onReset }: ChannelOptions = {},
): ChannelSubscription {
  return useSubscription(handle, {
    cursor: snapshot === undefined ? undefined : cursorOf(snapshot),
    onMessage: (event, payload) => handlers[event]?.(payload),
    onReset,
  });
}
