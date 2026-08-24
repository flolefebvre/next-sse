import { expect, test, vi } from "vitest";

import { createMemoryTransport } from "../transport/memory.js";

import type { ChannelRecord } from "../internal/channel.js";

import { toClientChannels } from "./client-channels.js";
import { asType, initSSE, SSEProvider } from "./index.js";
import type { RegistryLike } from "./registry.js";

const appWith = (channels: ChannelRecord): RegistryLike => {
  const { createSSE } = initSSE({ transport: createMemoryTransport() });

  return createSSE(channels);
};

/** A payload for a fixture that is about the allowlist, not about what a Channel carries. */
const anything = asType<{ text: string }>();

/** The decision every fixture here declares: these tests are about what crosses, not who may. */
const authorize = () => true;

test("a Channel crosses to the client as its pattern and its event names, and nothing else", () => {
  const sse = appWith({
    chat: { pattern: "chat:{roomId}", events: { message: anything, typing: anything }, authorize },
    inbox: { pattern: "inbox:{userId}", events: { mail: anything }, authorize },
  });

  expect(toClientChannels(sse)).toEqual({
    chat: { pattern: "chat:{roomId}", events: ["message", "typing"] },
    inbox: { pattern: "inbox:{userId}", events: ["mail"] },
  });
});

/**
 * The reason it is an allowlist and not an omission list: whatever a Channel declaration grows
 * — Authorize first, and Authorize is free to import a database — stays on the server unless
 * this function names it.
 */
test("anything else a Channel declares stays on the server", () => {
  const sse = appWith({
    chat: {
      pattern: "chat:{roomId}",
      events: { message: anything },
      authorize: () => secret.readTheDatabase(),
    },
  });

  const shared = toClientChannels(sse);

  expect(Object.keys(shared.chat ?? {})).toEqual(["pattern", "events"]);
  expect(JSON.stringify(shared)).not.toContain("authorize");
  expect(Object.values(shared).flatMap((one) => Object.values(one))).not.toContain(
    sse.channels.chat?.authorize,
  );
  expect(secret.readTheDatabase).not.toHaveBeenCalled();
});

/** Whatever an App's Authorize reaches for: it must not be run by the allowlist, or reach it. */
const secret = { readTheDatabase: vi.fn(() => true) };

/** It crosses a Server-Component boundary as a prop, so it has to be data all the way down. */
test("what crosses to the client is plain serialisable data", () => {
  const shared = toClientChannels(
    appWith({ chat: { pattern: "chat:{roomId}", events: {}, authorize } }),
  );

  expect(JSON.parse(JSON.stringify(shared))).toEqual(shared);
});

/**
 * ADR-0008 reserves the Registry's own keys, and the App hears about it where it wrote the
 * name. The quiet failure this replaces was the dangerous one: a Channel called `channels`
 * taking the declaration map and leaving the client with an empty allowlist, which would break
 * every subscription in the App and name nothing.
 */
test("a Channel named after one of the Registry's own keys is refused", () => {
  expect(() =>
    appWith({
      channels: { pattern: "channels:{id}", events: {}, authorize },
      chat: { pattern: "chat:{roomId}", events: { message: anything }, authorize },
    }),
  ).toThrow(/"channels".*is reserved/);
});

test("the provider hands the allowlist and the route to the client half", () => {
  const sse = appWith({
    chat: { pattern: "chat:{roomId}", events: { message: anything }, authorize },
  });

  const element = SSEProvider({ sse, url: "/live/stream", children: null });

  expect(element.props).toEqual({
    channels: { chat: { pattern: "chat:{roomId}", events: ["message"] } },
    url: "/live/stream",
    children: null,
  });
});

test("the provider leaves the route unset, so the client half applies its default", () => {
  const sse = appWith({ chat: { pattern: "chat:{roomId}", events: {}, authorize } });

  expect(SSEProvider({ sse, children: null }).props.url).toBeUndefined();
});
