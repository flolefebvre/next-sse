"use client";

import { useEffect, useRef, useState } from "react";

import { fillPattern } from "../internal/pattern.js";

import type { Status } from "./core.js";
import { useSSEContext } from "./provider.js";

/**
 * A Channel with its params filled in, as a Client Component holds it: the Registry key and
 * the params, and nothing else.
 *
 * That is the whole point of it. The pattern the key stands for lives in the provider's data,
 * put there by a Server Component, so a Client Component addresses a Channel without ever
 * importing the Registry module — which holds Authorize and whatever Authorize imports
 * (ADR-0002).
 */
export interface Handle {
  readonly key: string;
  readonly params: Record<string, string>;
}

/** What to do with each event a Channel carries. An event with no handler is ignored. */
export type Handlers = Record<string, (payload: unknown) => void>;

/** What `useChannel` gives back: where the Connection stands, and the Channel it resolved to. */
export interface ChannelSubscription {
  readonly status: Status;
  /** The Channel name, resolved from the provider's pattern — the name on the wire. */
  readonly channel: string;
}

/**
 * One Handle factory per Registry key. `handlers` and `channels` are the Registry's own,
 * reserved for it by ADR-0008, and are not Channels.
 */
export type Channels<Registry> = {
  [Key in Exclude<keyof Registry & string, "handlers" | "channels">]: (
    params?: Record<string, string>,
  ) => Handle;
};

export interface SSEClient<Registry> {
  /** `channels.chat({ roomId })`: a Handle, built from nothing but its key and its params. */
  readonly channels: Channels<Registry>;
  /** Subscribe to a Channel for as long as the component is mounted. */
  useChannel(handle: Handle, handlers: Handlers): ChannelSubscription;
}

/**
 * The client's entry: `createClient<typeof sse>()` in a `'use client'` module of the App, with
 * the Registry brought in by `import type` so no value of it crosses into the browser bundle.
 *
 * Payloads are `unknown` and every key is accepted until the Registry infers its own types;
 * the call site is already the final one, so that ticket narrows this without an App changing
 * a line.
 */
export function createClient<
  Registry extends object = Record<string, unknown>,
>(): SSEClient<Registry> {
  const channels = new Proxy({} as Channels<Registry>, {
    get: (_, key) =>
      typeof key === "string"
        ? (params: Record<string, string> = {}) => ({ key, params })
        : undefined,
  });

  function useChannel(handle: Handle, handlers: Handlers): ChannelSubscription {
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
     * The handlers are read at delivery time, never captured by the subscription: a component
     * that re-renders with a new closure — which is every render — must not cost a reconnect.
     */
    const latest = useRef(handlers);
    useEffect(() => {
      latest.current = handlers;
    });

    const { core } = context;
    useEffect(() => {
      setStatus("connecting");

      return core.subscribe({
        channel,
        onMessage: (event, payload) => latest.current[event]?.(payload),
        onStatus: setStatus,
      });
    }, [core, channel]);

    return { status, channel };
  }

  return { channels, useChannel };
}
