import type { ReactNode } from "react";

import type { ChannelDeclaration } from "../internal/channel.js";
import { sealSnapshot, type Snapshot } from "../internal/snapshot.js";
import type { StandardSchemaV1 } from "../internal/standard-schema.js";

import { fakeEventSources, type FakeEventSource } from "./fake-event-source.js";
import { createClient, SSEClientProvider, type ClientChannels } from "./index.js";

/**
 * The App every client test is written against, declared the way an App declares one: the
 * Registry is a type, the Channels are Handles, and no Channel name is spelled out in a
 * component.
 *
 * It is shared because the alternative is four files restating the same fixture, and because a
 * test that needs a different App can still make one — `createClient` takes its Registry as a
 * type argument and costs nothing.
 */
export type Chat = ChannelDeclaration<
  "chat:{roomId}",
  { message: StandardSchemaV1<{ id: string; text: string }> }
>;
export type Presence = ChannelDeclaration<
  "presence:{roomId}",
  { joined: StandardSchemaV1<{ who: string }> }
>;

export const { channels, useChannel, useChannelState } = createClient<{
  channels: { chat: Chat; presence: Presence };
}>();

/** What `<SSEProvider>` would have handed down: the allowlist, and nothing else. */
export const DECLARED: ClientChannels = {
  chat: { pattern: "chat:{roomId}", events: ["message"] },
  presence: { pattern: "presence:{roomId}", events: ["joined"] },
};

/**
 * Put a double where the browser's `EventSource` would be, and hand back the list of every
 * Connection opened through it, in order.
 *
 * jsdom registers no `EventSource` — no DOM shim does — so the global is what a test supplies.
 * The core takes its constructor by injection and defaults to that global, which is why nothing
 * here has to patch a module.
 */
export function installEventSource(): FakeEventSource[] {
  const fake = fakeEventSources();
  (globalThis as { EventSource?: unknown }).EventSource = fake.EventSource;

  return fake.opened;
}

/**
 * The provider a test mounts: the App's Channels, and an `onReset` of its own.
 *
 * The handler is what keeps the default — `router.refresh()`, and so `next/navigation` and an
 * App Router above the tree — out of every test that is not about Reset. Reset has its own file,
 * and it is the only one that mounts a router.
 */
export const app = (
  children: ReactNode,
  { url, onReset = () => undefined }: { url?: string; onReset?: () => void } = {},
) => (
  <SSEClientProvider channels={DECLARED} url={url} onReset={onReset}>
    {children}
  </SSEClientProvider>
);

/** What this App's `chat` Channel carries, and what a page of it holds a list of. */
export interface Message {
  id: string;
  text: string;
}

/** A list of Messages, keyed the way `upsertBy('id')` expects, from their texts alone. */
export const messagesOf = (...texts: string[]): Message[] =>
  texts.map((text, index) => ({ id: String(index + 1), text }));

/**
 * A Snapshot as `sse.snapshot(read)` would have minted it: the data, and the Cursor taken
 * before the read. Sealing one here rather than on the server is the only way a client test can
 * have one at all — the type is opaque by construction, and there is no other door.
 */
export const snapshotOf = (cursor: string, messages: Message[] = []): Snapshot<Message[]> =>
  sealSnapshot(cursor, messages);
