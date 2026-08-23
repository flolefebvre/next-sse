import {
  createClient,
  SSEClientProvider,
  upsertBy,
  type Snapshot,
  type Status,
} from "@flefebvre/next-sse/client";
import { initSSE, SSEProvider, toClientChannels } from "@flefebvre/next-sse/server";
import { FakeEventSource, transportContract } from "@flefebvre/next-sse/testing";
import {
  createPublisher,
  TransportClosedError,
  TransportError,
  TransportUnavailableError,
  type Cursor,
  type Entry,
  type Page,
  type Publisher,
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
];

/** And every type of the public surface, named the way the ADRs name them. */
export type Types = [
  Snapshot<{ id: string }>,
  Status,
  Cursor,
  Entry,
  Page,
  Publisher,
  StoredEntry,
  Transport,
  Unsubscribe,
];
