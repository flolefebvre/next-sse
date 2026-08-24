import type { ChannelDeclaration } from "../internal/channel.js";
import type { StandardSchemaV1 } from "../internal/standard-schema.js";

import { fakeEventSources, type FakeEventSource } from "./fake-event-source.js";
import { createClient, type ClientChannels } from "./index.js";

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

export const { channels, useChannel } = createClient<{
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
