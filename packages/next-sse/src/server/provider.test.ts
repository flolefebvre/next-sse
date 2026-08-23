import { expect, test } from "vitest";

import { createMemoryTransport } from "../transport/memory.js";

import { toClientChannels } from "./client-channels.js";
import { initSSE, SSEProvider } from "./index.js";
import type { ChannelDeclaration, Registry } from "./registry.js";

const appWith = (channels: Record<string, ChannelDeclaration>): Registry => {
  const { createSSE } = initSSE({ transport: createMemoryTransport() });

  return createSSE(channels);
};

test("a Channel crosses to the client as its pattern and its event names, and nothing else", () => {
  const sse = appWith({
    chat: { pattern: "chat:{roomId}", events: { message: undefined, typing: undefined } },
    inbox: { pattern: "inbox:{userId}", events: { mail: undefined } },
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
  const authorize = () => true;
  const sse = appWith({
    chat: { pattern: "chat:{roomId}", events: { message: undefined }, authorize } as never,
  });

  const shared = toClientChannels(sse);

  expect(Object.keys(shared.chat ?? {})).toEqual(["pattern", "events"]);
  expect(JSON.stringify(shared)).not.toContain("authorize");
});

/** It crosses a Server-Component boundary as a prop, so it has to be data all the way down. */
test("what crosses to the client is plain serialisable data", () => {
  const shared = toClientChannels(appWith({ chat: { pattern: "chat:{roomId}", events: {} } }));

  expect(JSON.parse(JSON.stringify(shared))).toEqual(shared);
});

test("the provider hands the allowlist and the route to the client half", () => {
  const sse = appWith({ chat: { pattern: "chat:{roomId}", events: { message: undefined } } });

  const element = SSEProvider({ sse, url: "/live/stream", children: null });

  expect(element.props).toEqual({
    channels: { chat: { pattern: "chat:{roomId}", events: ["message"] } },
    url: "/live/stream",
    children: null,
  });
});

test("the provider leaves the route unset, so the client half applies its default", () => {
  const sse = appWith({ chat: { pattern: "chat:{roomId}", events: {} } });

  expect(SSEProvider({ sse, children: null }).props.url).toBeUndefined();
});
