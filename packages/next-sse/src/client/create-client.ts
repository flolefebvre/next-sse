"use client";

import { useEffect, useRef, useState } from "react";

import type { ChannelRecord, EventMap, EventsOf, PatternOf } from "../internal/channel.js";
import { fillPattern, type ParamsArgs } from "../internal/pattern.js";
import type { ReservedRegistryKey } from "../internal/reserved.js";
import type { InferOutput } from "../internal/standard-schema.js";

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
export interface Handle<Key extends string = string> {
  readonly key: Key;
  readonly params: Record<string, string>;
}

/**
 * What to do with each event a Channel carries. An event with no handler is ignored, and a
 * payload is the schema's Output: what the Publish validated, and so what the wire carries
 * (ADR-0006).
 */
export type Handlers<Events extends EventMap = EventMap> = {
  [Name in keyof Events & string]?: (payload: InferOutput<Events[Name]>) => void;
};

/** What `useChannel` gives back: where the Connection stands, and the Channel it resolved to. */
export interface ChannelSubscription {
  readonly status: Status;
  /** The Channel name, resolved from the provider's pattern — the name on the wire. */
  readonly channel: string;
}

/**
 * The App's Channels, read off the Registry type: the declarations, which is the one place
 * both sides agree on a pattern and its events.
 */
type ChannelsOf<Registry> = Registry extends { channels: infer Declared extends ChannelRecord }
  ? Declared
  : never;

/**
 * One Handle factory per Channel, taking the params its pattern names. The Registry's own keys
 * (ADR-0008) are excluded from the list they are declared in, never restated here.
 */
export type Channels<Registry> = {
  [Key in Exclude<keyof ChannelsOf<Registry> & string, ReservedRegistryKey>]: (
    ...args: ParamsArgs<PatternOf<ChannelsOf<Registry>[Key]>>
  ) => Handle<Key>;
};

export interface SSEClient<Registry> {
  /** `channels.chat({ roomId })`: a Handle, built from nothing but its key and its params. */
  readonly channels: Channels<Registry>;
  /** Subscribe to a Channel for as long as the component is mounted. */
  useChannel<Key extends keyof ChannelsOf<Registry> & string>(
    handle: Handle<Key>,
    handlers: Handlers<EventsOf<ChannelsOf<Registry>[Key]>>,
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
 */
export function createClient<Registry extends { channels: ChannelRecord }>(): SSEClient<Registry> {
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
