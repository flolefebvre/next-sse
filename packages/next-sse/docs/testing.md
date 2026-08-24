# Testing reference

Everything in `@flefebvre/next-sse/testing`. It is for an App's own suite: the `EventSource`
double the library's client tests run on, the Snapshot sealer, and the contract suite every
Transport owes. `vitest` is an optional peer dependency, needed only by `transportContract`.

## Testing a live component

Three things make a component test work, and they are the whole setup:

1. **The `EventSource` is the seam.** jsdom registers none, so the test supplies the global.
   `fakeEventSources()` hands back every Connection opened through it, in order, and a Message is
   delivered by calling a method on one. No network, no timers, no waiting.
2. **`SSEClientProvider` replaces `<SSEProvider>`.** The server provider reads the Registry —
   Authorize, the Transport, whatever the App's session module imports — and a component test has
   no business loading any of it. Pass the Channel allowlist as a plain object, and pass `onReset`
   so nothing reaches for `next/navigation`.
3. **Mock your own server actions, and nothing of the library.** A `"use server"` module imported
   in jsdom pulls in `next/headers` and the server-only Registry.

```tsx
import { SSEClientProvider } from "@flefebvre/next-sse/client";
import { fakeEventSources, snapshotOf, type FakeEventSource } from "@flefebvre/next-sse/testing";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

import { Messages } from "./messages";

vi.mock("./actions", () => ({
  send: vi.fn(() => Promise.resolve({ id: "sent-1", text: "from the action" })),
}));

const CHANNELS = { chat: { pattern: "chat:{roomId}", events: ["message"] } } as const;

test("the room shows what the server rendered, then what arrives", async () => {
  const fake = fakeEventSources();
  (globalThis as { EventSource?: unknown }).EventSource = fake.EventSource;

  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <SSEClientProvider channels={CHANNELS} onReset={() => undefined}>
        <Messages roomId="42" snapshot={snapshotOf([{ id: "1", text: "rendered" }], "cursor-0")} />
      </SSEClientProvider>,
    );
  });

  // The Connection is opened a tick after the render: the client coalesces the Channels of the
  // whole tree, so a page mounting five hooks opens one Connection rather than five.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const connection = fake.opened[0] as FakeEventSource;
  expect(connection.channels).toEqual(["chat:42"]);
  expect(connection.cursor).toBe("cursor-0");

  await act(async () => {
    connection.ready();
    connection.caughtUp();
    connection.message("chat:42", "message", { id: "2", text: "arrived" });
  });

  expect(container.querySelectorAll("li")).toHaveLength(2);
});
```

Set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` in the file or in the project's setup, and run
it in a jsdom environment that does **not** set the `react-server` resolve condition.

The full version of this test, against a real component:
[patterns/testing-your-app.md](patterns/testing-your-app.md).

## `fakeEventSources()`

Returns `{ EventSource, opened }` — a constructor to put where the browser's would be, and the
list of every Connection opened through it, in order. Counting Connections is most of what these
tests assert.

## `FakeEventSource`

| Member                                        | What it does                                                         |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `channels`                                    | the Channels this Connection asked for, read off its URL             |
| `cursor`                                      | the Cursor it resumes from, or `null` when it opened live-only       |
| `ready(data?)`                                | the Control event that opens every stream                            |
| `caughtUp()`                                  | the Control event that ends the replay                               |
| `message(channel, event, payload, cursor?)`   | one Message, framed the way the wire frames it                       |
| `emit(type, data?, id?)`                      | any block, for the Control events the two helpers above do not cover |
| `drop()`                                      | the pipe broke and the browser is retrying on its own                |
| `fail()`                                      | the server answered something that is not a stream                   |
| `close()`, `url`, `readyState`                | the `EventSource` interface itself                                   |

`ready()` defaults to `{ cursor: "cursor-0", refused: [] }`. Pass `{ refused: ["admin"], … }` to
test a refused Channel, and a `heartbeat` to arm the watchdog.

## `snapshotOf(data, cursor)`

A Snapshot for a test, sealed through the very function the server uses. A Snapshot is opaque by
type, so without this a test would have to open it with a cast. Any string works as the Cursor —
it is opaque above the Transport — and a test driving a `FakeEventSource` reads it back off the
Connection's URL to assert the resume happened.

It lives in `./testing` and nowhere else: minting a Snapshot around data in production code would
claim a position the log never gave.

## `transportContract(options)`

The whole log obligation, as a Vitest suite. Call it in a test file of your own with a factory:

```ts
transportContract({
  create: ({ retention }) => createArrayLogTransport({ retention }),
});
```

`create` must answer an **empty** log honouring the Retention it is given — a factory sharing one
backend must isolate each call, for instance with a fresh Prefix.

Two optional backend hooks unlock the cases that no log can stage on its own:

```ts
transportContract({
  create: ({ retention }) => createRedisTransport({ url, prefix: unique(), retention }),
  backend: {
    peer: (transport) => createRedisTransport({ url, prefix: prefixOf(transport) }),
    outage: {
      begin: (transport) => cutOff(transport),
      end: (transport) => letBackIn(transport),
    },
  },
});
```

- **`peer`** — another Transport on the same log, standing for a second Instance.
- **`outage`** — cut **one** Transport off from the backend and let it back in. The outage must be
  that Transport's alone: a `peer` goes on publishing throughout, which is the only way a gap can
  be staged. A backend that can only be stopped wholesale cannot supply this hook honestly.

Cases needing a hook that was not supplied are reported as skipped, by name — never silently
passed.

## Testing without a browser

Two seams beyond the ones above, both used by the library's own suite and available to any App:

- **The Memory Transport in one process**: two `initSSE` Instances sharing one Transport prove
  fan-out, replay and Kick across Instances with no Next.js at all.
- **The stream over HTTP**: an `EventSource` from `undici` against a running App reads `ready`,
  the replay and the live feed exactly as a browser would, which is how a protocol-level test
  obtains a Cursor without parsing HTML.
