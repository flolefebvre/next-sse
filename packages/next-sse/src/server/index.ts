import type { ChannelRecord, NoReservedKeys } from "../internal/channel.js";
import type { Transport } from "../transport/index.js";

import { getInstance } from "./instance.js";
import { channel, createSSE, type ChannelFactory, type Registry } from "./registry.js";

export type { ChannelFactory, Handle, Registry, RegistryLike } from "./registry.js";
export type {
  Authorize,
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

export interface InitOptions<Ctx = undefined> {
  /**
   * What this App builds from the request, once per Connection, for its Authorize to decide on
   * — a session read, a user row, whatever the decision needs. It is optional: an App with only
   * public Channels writes none, and its `Ctx` is `undefined` (ADR-0008). Whatever it returns
   * is what types the `ctx` of every `authorize` this App declares, which is why `channel`
   * comes back from here rather than from the package.
   */
  context?: (request: Request) => Ctx | Promise<Ctx>;
  /**
   * The opaque identity of a Connection — a user or session id — derived once from the context
   * (ADR-0003). It is the only thing the library knows about who holds a Connection, and what a
   * Kick will address Connections by. `undefined` for a Connection nobody can name.
   */
  key?: (ctx: Ctx) => string | undefined;
  /**
   * The log this App runs on. Omitted, the App gets the one its environment chooses (ADR-0008):
   * the Redis Transport when `REDIS_URL` is set, the Memory Transport — which serves one
   * Instance — when it is not. Every other option of ADR-0008 joins this type as the ticket that
   * honours it lands: an option that is declared but ignored is a promise the library does not
   * keep.
   */
  transport?: Transport;
}

/**
 * The App's single entry into the library: it takes the Instance's configuration and returns
 * the two factories the App declares its Registry with.
 *
 * `Ctx` is read off `context`, and the `channel` handed back is bound to it: every `authorize`
 * this App declares is typed with the very thing this App builds, and an App that configures no
 * `context` declares Authorize on `undefined`. That is the whole reason the factory comes from
 * here — a `channel` exported by the package could only ever be typed on nothing.
 */
export function initSSE<Ctx = undefined>(
  options: InitOptions<Ctx> = {},
): {
  channel: ChannelFactory<Ctx>;
  createSSE: <Channels extends ChannelRecord>(
    channels: Channels & NoReservedKeys<Channels>,
  ) => Registry<Channels>;
} {
  const instance = getInstance(options);

  return {
    channel: channel as ChannelFactory<Ctx>,
    createSSE: (channels) => createSSE(instance, channels),
  };
}
