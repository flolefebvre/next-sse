import { SSEClientProvider } from "@flefebvre/next-sse/client";
import { fakeEventSources, snapshotOf, type FakeEventSource } from "@flefebvre/next-sse/testing";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

import type { Message } from "@/lib/messages";

import { Messages } from "./messages";

/**
 * Testing a component of your own App, with the Connection in your hands.
 *
 * Three things make this work, and they are all a consumer needs to know:
 *
 * 1. **The `EventSource` is the seam.** jsdom registers none, so the test supplies the global;
 *    `fakeEventSources()` from `@flefebvre/next-sse/testing` hands back every Connection opened
 *    through it, in order, and a Message is delivered by calling a method on one. No network,
 *    no timers, no waiting.
 * 2. **`SSEClientProvider` replaces `<SSEProvider>`.** The server provider reads the Registry —
 *    Authorize, the Transport, whatever the App's session module imports — and a component test
 *    has no business loading any of it. What crosses to the client is the Channel allowlist,
 *    which is the plain object below. Passing `onReset` keeps `next/navigation` out of the tree,
 *    so no App Router is needed above it.
 * 3. **The server actions are mocked, and nothing of the library is.** `send` is a `"use server"`
 *    module: importing it in jsdom would pull in `next/headers` and the App's server-only
 *    Registry. Mocking the App's own action is the whole of the setup — the hooks, the
 *    Connection and the reducers are the real ones.
 *
 * The Snapshot the page would have handed down comes from `snapshotOf(data, cursor)`, also in
 * `./testing`: a Snapshot is opaque by type, sealed by the server, and this seals one the same
 * way so that a test never opens the type with a cast.
 */
vi.mock("./actions", () => ({
  send: vi.fn((_roomId: string, text: string): Promise<Message> =>
    Promise.resolve({ id: "sent-1", text: `${text} (from the action)` }),
  ),
}));

/** What `<SSEProvider>` hands down: the Channels of this App, and nothing else about them. */
const CHANNELS = {
  chat: { pattern: "chat:{roomId}", events: ["message"] },
} as const;

/**
 * Mount a tree in jsdom and let its effects run — ten lines of `react-dom`, which is all a
 * component test of a hook needs. React's own `act` is what flushes the effects that open the
 * Connection, and every `act` below is the same call doing the same job.
 */
async function mount(ui: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });

  return container;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Let one macrotask turn pass. The Connection is not opened in the render that mounts the hook:
 * the client core coalesces the Channels of the whole tree on a tick, so that a page mounting
 * five hooks opens one Connection rather than five. A test asks for that tick before looking at
 * what was opened.
 */
const settle = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** The rows the component is showing, as a reader would read them. */
const rows = (container: HTMLElement, testId: string): string[] =>
  Array.from(container.querySelectorAll(`[data-testid="${testId}"] li`)).map(
    (row) => row.textContent ?? "",
  );

test("the room shows what the server rendered, then what arrives on the Channel", async () => {
  const fake = fakeEventSources();
  (globalThis as { EventSource?: unknown }).EventSource = fake.EventSource;

  const container = await mount(
    <SSEClientProvider channels={CHANNELS} onReset={() => undefined}>
      <Messages
        roomId="42"
        snapshot={snapshotOf([{ id: "1", text: "rendered on the server" }], "cursor-0")}
      />
    </SSEClientProvider>,
  );

  expect(rows(container, "messages")).toEqual(["rendered on the server"]);

  await settle();

  /**
   * One Connection, carrying the Channel the Handle named, resuming from the position the
   * Snapshot was taken at. The component never spelled either of them out: the pattern came
   * from the provider and the position from the Snapshot.
   */
  const connection = fake.opened[0] as FakeEventSource;
  expect(connection.channels).toEqual(["chat:42"]);
  expect(connection.cursor).toBe("cursor-0");

  await act(async () => {
    connection.ready();
    connection.caughtUp();
  });
  expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("live");

  /**
   * A Message off the wire, and the same Message again: the reducer this component was given is
   * `upsertBy("id")`, so a replayed or echoed Message is the one it already has, not a second
   * row. That is the assertion worth writing for any live list.
   */
  await act(async () => {
    connection.message("chat:42", "message", { id: "2", text: "published by somebody else" });
    connection.message("chat:42", "message", { id: "2", text: "published by somebody else" });
  });

  expect(rows(container, "messages")).toEqual([
    "rendered on the server",
    "published by somebody else",
  ]);
});
