"use client";

import { useEffect, useRef, useState } from "react";

import { fillPattern } from "../internal/pattern.js";

import type { Status } from "./core.js";
import type { ChannelSubscription, Handle } from "./handle.js";
import { useSSEContext } from "./provider.js";

/** What one hook asks of the shared Connection, untyped: the hooks above it own the types. */
export interface Subscribing {
  /** Where this subscriber resumes from, when it brought a Snapshot. */
  cursor?: string;
  /** One Message on its Channel: the declared event name, and the payload as published. */
  onMessage(event: string, payload: unknown): void;
  /** What this subscriber does about a Reset, when it does not leave it to the provider. */
  onReset?: () => void;
}

/**
 * The primitive every hook is built on: resolve the Handle against the provider's data,
 * subscribe for as long as the component is mounted, and report where the Connection stands.
 *
 * It exists so that `useChannel` and `useChannelState` cannot drift: what a Channel name is,
 * when a subscription is torn down and rebuilt, and what a Cursor does to the Connection are
 * decided once, here.
 */
export function useSubscription(handle: Handle, subscribing: Subscribing): ChannelSubscription {
  const context = useSSEContext();
  const declared = context.channels[handle.key];
  if (declared === undefined) {
    throw new Error(
      `next-sse: no Channel "${handle.key}" in this App's Registry. The provider carries: ` +
        `${Object.keys(context.channels).join(", ") || "none"}.`,
    );
  }
  const channel = fillPattern(declared.pattern, handle.params);

  const [status, setStatus] = useState<Status>("connecting");

  /**
   * What to do with a Message is read at delivery time, never captured by the subscription: a
   * component that re-renders with a new closure — which is every render — must not cost a
   * reconnect.
   */
  const latest = useRef(subscribing);
  useEffect(() => {
    latest.current = subscribing;
  });

  /**
   * Whether this hook handles a Reset itself is part of the subscription rather than read
   * through the ref, because the core answers a Reset by calling the provider's handler once
   * for every subscriber that brought none: it has to know which ones those are.
   */
  const { cursor } = subscribing;
  const own = subscribing.onReset !== undefined;
  const { core } = context;
  useEffect(() => {
    setStatus("connecting");

    return core.subscribe({
      channel,
      cursor,
      onMessage: (event, payload) => latest.current.onMessage(event, payload),
      onStatus: setStatus,
      ...(own ? { onReset: () => latest.current.onReset?.() } : {}),
    });
  }, [core, channel, cursor, own]);

  return { status, channel };
}
