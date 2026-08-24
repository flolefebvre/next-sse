import type { ChannelRecord, NoReservedKeys } from "../internal/channel.js";
import type { Transport } from "../transport/index.js";

import { getInstance } from "./instance.js";
import { channel, createSSE, type Registry } from "./registry.js";

export type { Handle, Registry, RegistryLike } from "./registry.js";
export type {
  ChannelDeclaration,
  ChannelRecord,
  EventMap,
  EventsOf,
  PatternOf,
} from "../internal/channel.js";
export type { JsonValue } from "../internal/json.js";
export type { ParamNames, ParamsArgs, ParamsOf } from "../internal/pattern.js";
export { asType, InvalidPayloadError } from "../internal/standard-schema.js";
export type {
  InferInput,
  InferOutput,
  StandardIssue,
  StandardResult,
  StandardSchemaV1,
} from "../internal/standard-schema.js";
export { toClientChannels } from "./client-channels.js";
export { SSEProvider } from "./provider.js";
export type { SSEProviderProps } from "./provider.js";
export type { ClientChannel, ClientChannels } from "../client/index.js";

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
  createSSE: <Channels extends ChannelRecord>(
    channels: Channels & NoReservedKeys<Channels>,
  ) => Registry<Channels>;
} {
  const instance = getInstance(options);

  return {
    channel,
    createSSE: (channels) => createSSE(instance, channels),
  };
}
