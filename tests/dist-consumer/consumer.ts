import {
  createClient,
  SSEClientProvider,
  upsertBy,
  type ChannelOptions,
  type ChannelState,
  type ChannelSubscription,
  type Channels,
  type ClientChannel,
  type ClientChannels,
  type Handle,
  type Handlers,
  type Pending,
  type Reducers,
  type ResetOption,
  type Snapshot,
  type SSEClient,
  type SSEClientProviderProps,
  type Status,
} from "@flefebvre/next-sse/client";
import {
  asType,
  initSSE,
  InvalidPayloadError,
  SSEProvider,
  toClientChannels,
  type ChannelDeclaration,
  type ChannelRecord,
  type EventMap,
  type EventsOf,
  type InferInput,
  type InferOutput,
  type JsonValue,
  type ParamNames,
  type ParamsArgs,
  type ParamsOf,
  type PatternOf,
  type Registry,
  type RegistryLike,
  type SSEProviderProps,
  type StandardIssue,
  type StandardResult,
  type StandardSchemaV1,
  type Handle as ServerHandle,
} from "@flefebvre/next-sse/server";
import {
  FakeEventSource,
  fakeEventSources,
  snapshotOf,
  transportContract,
  type TransportBackend,
  type TransportContractOptions,
} from "@flefebvre/next-sse/testing";
import {
  createPublisher,
  TransportClosedError,
  TransportError,
  TransportUnavailableError,
  type Cursor,
  type Entry,
  type Page,
  type Publisher,
  type Retention,
  type StoredEntry,
  type Transport,
  type Unsubscribe,
} from "@flefebvre/next-sse/transport";
import { createMemoryTransport } from "@flefebvre/next-sse/transport/memory";
import { createRedisPublisher, createRedisTransport } from "@flefebvre/next-sse/transport/redis";

/**
 * What a consumer holds: every value of every subpath entry, resolved through the real
 * `exports` map against the built `dist`, with `skipLibCheck` off — the setting that otherwise
 * degrades a broken declaration to `any` instead of erroring.
 */
export const values = [
  initSSE,
  asType,
  InvalidPayloadError,
  SSEProvider,
  toClientChannels,
  createClient,
  SSEClientProvider,
  upsertBy,
  createPublisher,
  TransportError,
  TransportUnavailableError,
  TransportClosedError,
  createMemoryTransport,
  createRedisTransport,
  createRedisPublisher,
  transportContract,
  FakeEventSource,
  fakeEventSources,
  snapshotOf,
];

/**
 * The double as a consumer's jsdom test holds it: a recorder in the global's place, and a real
 * `FakeEventSource` to drive out of `opened`. Compiled, not run — what it proves is that the
 * shape composes off the built declarations, through the real exports map.
 */
export function driveOneConnection(): string[] {
  const fake = fakeEventSources();
  (globalThis as { EventSource?: unknown }).EventSource = fake.EventSource;

  const connection: FakeEventSource | undefined = fake.opened[0];
  connection?.ready();
  connection?.caughtUp();
  connection?.message("chat:42", "message", { text: "one" }, "cursor-1");

  return connection?.channels ?? [];
}

/** One App's Registry type, which is what the typed surface is read against. */
type AnApp = {
  channels: {
    chat: ChannelDeclaration<"chat:{roomId}", { message: StandardSchemaV1<{ text: string }> }>;
  };
};

/** And every type of the public surface, named the way the ADRs name them. */
export type Types = [
  Snapshot<{ id: string }>,
  Status,
  ChannelSubscription,
  ChannelDeclaration<"chat:{roomId}", { message: StandardSchemaV1<{ text: string }> }>,
  ChannelRecord,
  Channels<AnApp>,
  EventMap,
  EventsOf<AnApp["channels"]["chat"]>,
  InferInput<StandardSchemaV1<{ text: string }>>,
  InferOutput<StandardSchemaV1<{ text: string }>>,
  JsonValue,
  ParamNames<"chat:{roomId}">,
  ParamsArgs<"chat:{roomId}">,
  ParamsOf<"chat:{roomId}">,
  PatternOf<AnApp["channels"]["chat"]>,
  Registry<AnApp["channels"]>,
  RegistryLike,
  ServerHandle<AnApp["channels"]["chat"]["events"]>,
  StandardIssue,
  StandardResult<{ text: string }>,
  StandardSchemaV1<{ text: string }>,
  ClientChannel,
  ClientChannels,
  ChannelOptions,
  ChannelState<AnApp["channels"]["chat"]["events"], { text: string }[]>,
  Handle,
  Handlers,
  Pending<AnApp["channels"]["chat"]["events"]>,
  Reducers<AnApp["channels"]["chat"]["events"], { text: string }[]>,
  ResetOption,
  SSEClient<AnApp>,
  SSEClientProviderProps,
  SSEProviderProps,
  Cursor,
  Entry,
  Page,
  Publisher,
  Retention,
  StoredEntry,
  Transport,
  Unsubscribe,
  TransportBackend,
  TransportContractOptions,
];
