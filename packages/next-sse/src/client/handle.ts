import type { ChannelRecord, EventMap, PatternOf } from "../internal/channel.js";
import type { ParamsArgs } from "../internal/pattern.js";
import type { ReservedRegistryKey } from "../internal/reserved.js";
import type { Snapshot } from "../internal/snapshot.js";
import type { InferOutput } from "../internal/standard-schema.js";

import type { Status } from "./core.js";

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

/** What every hook takes beyond its Channel: where to resume, and what a Reset means here. */
export interface ChannelOptions {
  /**
   * The Snapshot a server component handed down. Subscribing with one makes the shared
   * Connection reopen from the position that render read its data at, so nothing published in
   * between is lost (ADR-0007). Without one the hook is live-only: it is told nothing of a
   * replay until the Connection has caught up, because it has no way to tell a replayed
   * Message from one it already has.
   */
  snapshot?: Snapshot;
  /**
   * What this hook does when the Instance says its Cursor is unusable. Omitted, the provider's
   * handler covers it — `router.refresh()` unless the App said otherwise — which is why an
   * ordinary page needs no code for Reset at all.
   */
  onReset?: () => void;
}

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
export type ChannelsOf<Registry> = Registry extends {
  channels: infer Declared extends ChannelRecord;
}
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
