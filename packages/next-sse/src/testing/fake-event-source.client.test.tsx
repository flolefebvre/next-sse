import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";

import type { ChannelDeclaration } from "../internal/channel.js";
import type { StandardSchemaV1 } from "../internal/standard-schema.js";

import { createClient, SSEClientProvider } from "../client/index.js";

import { fakeEventSources } from "./index.js";

/**
 * A consumer testing their own component, written the way a consumer has to write it: nothing
 * here comes from anywhere but `./client` and `./testing`, and the library's own React harness
 * is deliberately not used.
 *
 * Three things are under test at once, and all three are ADR-0008 promises. That `./testing`
 * really exports the double and its recorder — the other client tests reach the module
 * directly, so only this one crosses the entry. That a component test needs no App Router:
 * `onReset` is given, so the provider never renders `<RouterReset>` and `next/navigation` never
 * loads (the note on #35). And that a jsdom test can drive the whole path with no network, by
 * putting the double where the browser's `EventSource` would be.
 */
const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; EventSource?: unknown };
globals.IS_REACT_ACT_ENVIRONMENT = true;

type Chat = ChannelDeclaration<"chat:{roomId}", { message: StandardSchemaV1<{ text: string }> }>;

const { channels, useChannel } = createClient<{ channels: { chat: Chat } }>();

/** What `toClientChannels(sse)` hands the provider, written out as a consumer's fixture. */
const DECLARED = { chat: { pattern: "chat:{roomId}", events: ["message"] } };

function Room() {
  const [texts, setTexts] = useState<string[]>([]);
  useChannel(channels.chat({ roomId: "42" }), {
    message: ({ text }) => {
      setTexts((seen) => [...seen, text]);
    },
  });

  return (
    <ul>
      {texts.map((text) => (
        <li key={text}>{text}</li>
      ))}
    </ul>
  );
}

test("a consumer drives their own component over the double from ./testing", async () => {
  const fake = fakeEventSources();
  globals.EventSource = fake.EventSource;

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SSEClientProvider channels={DECLARED} onReset={() => undefined}>
        <Room />
      </SSEClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const [connection] = fake.opened;
  expect(connection?.channels).toEqual(["chat:42"]);

  /**
   * The stream as the Instance opens it: `ready`, then `caught-up` — a subscriber that brought
   * no Snapshot is told nothing until the Connection is live (ADR-0007), so the double has to
   * be driven through both Control events before a Message means anything.
   */
  await act(async () => {
    connection?.ready();
    connection?.caughtUp();
    connection?.message("chat:42", "message", { text: "from the worker" }, "cursor-1");
  });

  expect(container.textContent).toBe("from the worker");

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
