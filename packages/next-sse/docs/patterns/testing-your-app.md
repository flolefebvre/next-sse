# Testing your app

A live component, tested in jsdom, with the Connection in your hands: no network, no timers, no
waiting.

Example app:
[`app/messages.test.tsx`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/messages.test.tsx).

## The three moves

1. **The `EventSource` is the seam.** jsdom registers none, so the test supplies the global.
   `fakeEventSources()` hands back every Connection opened through it, in order.
2. **`SSEClientProvider` replaces `<SSEProvider>`**, with the Channel allowlist as a plain object.
   The server provider would load the Registry — Authorize, the Transport, the App's session
   module — which a component test has no business loading. Passing `onReset` keeps
   `next/navigation` out of the tree, so no App Router is needed above it.
3. **Mock your own server actions, and nothing of the library.** A `"use server"` module imported
   in jsdom pulls in `next/headers` and the server-only Registry. The hooks, the Connection and the
   reducers stay real.

## The whole test

```tsx
// app/messages.test.tsx
import { SSEClientProvider } from "@flefebvre/next-sse/client";
import { fakeEventSources, snapshotOf, type FakeEventSource } from "@flefebvre/next-sse/testing";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

import { Messages } from "./messages";

vi.mock("./actions", () => ({
  send: vi.fn((_roomId: string, text: string) =>
    Promise.resolve({ id: "sent-1", text: `${text} (from the action)` }),
  ),
}));

/** What <SSEProvider> hands down: the Channels of this App, and nothing else about them. */
const CHANNELS = { chat: { pattern: "chat:{roomId}", events: ["message"] } } as const;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(ui: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });

  return container;
}

/** One macrotask turn: the Channel set is coalesced on a tick before the Connection opens. */
const settle = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

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

  // One Connection, carrying the Channel the Handle named, resuming from the Snapshot's position.
  // The component spelled out neither: the pattern came from the provider, the position from the
  // Snapshot.
  const connection = fake.opened[0] as FakeEventSource;
  expect(connection.channels).toEqual(["chat:42"]);
  expect(connection.cursor).toBe("cursor-0");

  await act(async () => {
    connection.ready();
    connection.caughtUp();
  });
  expect(container.querySelector('[data-testid="status"]')?.textContent).toBe("live");

  // The same Message twice: the reducer is upsertBy("id"), so a replayed or echoed Message is the
  // one it already has, not a second row. That is the assertion worth writing for any live list.
  await act(async () => {
    connection.message("chat:42", "message", { id: "2", text: "published by somebody else" });
    connection.message("chat:42", "message", { id: "2", text: "published by somebody else" });
  });

  expect(rows(container, "messages")).toEqual([
    "rendered on the server",
    "published by somebody else",
  ]);
});
```

Run it in a jsdom environment that does **not** set the `react-server` resolve condition — a
Vitest project of its own is the tidy way.

## More scenarios

```ts
// A refused Channel: the page carries on, this hook reports it.
connection.ready({ cursor: "cursor-0", refused: ["admin"], heartbeat: 15000 });

// A transient drop: the browser retries on its own, the component shows "reconnecting".
connection.drop();

// A Reset: the Cursor is unusable, and the App has to read again.
connection.emit("reset", { cursor: "cursor-9" });

// The Instance ending a Connection — a Kick, a Drain, the max lifetime.
connection.emit("reconnect");
// The client opens a new one; assert on fake.opened[1].
```

## Testing the server side

- **A Publish and its Handle** — call the action and assert on what your data layer stored; the
  Publish itself is the library's business.
- **Authorize** — it is a plain function in the Registry. Call it with params and a context.
- **Across Instances, without Next.js** — two `initSSE` Instances sharing one Transport prove
  fan-out, replay and Kick in one process ([testing.md](../testing.md)).
- **Over the wire** — an `EventSource` from `undici` against a running App reads `ready`, the
  replay and the live feed exactly as a browser does, and is how a protocol-level test obtains a
  Cursor without parsing HTML.

## Notes

- Count Connections. One page holds one, however many hooks it mounts; `fake.opened.length` is the
  assertion that catches a regression there.
- `snapshotOf(data, cursor)` seals a Snapshot the way the server does, so no test needs a cast.
  Any string works as the Cursor.
- Nothing in the library needs to be mocked. If a test reaches for that, the seam is wrong.
