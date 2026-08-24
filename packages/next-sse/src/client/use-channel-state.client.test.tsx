import { useState } from "react";
import { beforeEach, expect, test } from "vitest";

import type { Snapshot } from "../internal/snapshot.js";

import {
  app,
  channels,
  installEventSource,
  messagesOf,
  snapshotOf,
  useChannelState,
  type Message,
} from "./app.testkit.js";
import type { FakeEventSource } from "./fake-event-source.js";
import { upsertBy } from "./index.js";
import { act, click, flush, mount } from "./react.testkit.js";

/**
 * The primary client shape (ADR-0007): the hook owns the list, the page hands it a Snapshot,
 * and nothing in a component names a Cursor or a Channel string.
 */
let opened: FakeEventSource[] = [];

beforeEach(() => {
  opened = installEventSource();
});

function Room({ snapshot }: { snapshot: Snapshot<Message[]> }) {
  const {
    state,
    status,
    pending,
    inFlight,
    apply,
    act: send,
  } = useChannelState(channels.chat({ roomId: "42" }), snapshot, { message: upsertBy("id") });

  return (
    <div data-status={status} data-in-flight={String(inFlight)}>
      <ul>
        {state.map((message) => (
          <li key={message.id}>{message.text}</li>
        ))}
      </ul>
      <ol>
        {pending.message.map((message) => (
          <li key={message.id}>{message.text}</li>
        ))}
      </ol>
      <button onClick={() => apply("message", { id: "9", text: "applied" })}>apply</button>
      <button
        onClick={() =>
          send("message", { id: "9", text: "sending" }, async () => {
            await settled;

            return { id: "9", text: "sent" };
          })
        }
      >
        send
      </button>
    </div>
  );
}

/** The server action of the `act` tests, resolved by hand so the in-flight moment can be read. */
let settle = (): void => undefined;
let settled = Promise.resolve();

beforeEach(() => {
  settled = new Promise<void>((resolve) => {
    settle = () => {
      resolve();
    };
  });
});

const texts = (tree: { container: HTMLElement }, selector = "ul") =>
  Array.from(tree.container.querySelectorAll(`${selector} li`), (item) => item.textContent);

test("the state starts as what the server read, and the Connection resumes from that read", async () => {
  const tree = await mount(
    app(<Room snapshot={snapshotOf("cursor-3", messagesOf("one", "two"))} />),
  );
  await flush();

  expect(texts(tree)).toEqual(["one", "two"]);
  expect(opened[0]?.cursor).toBe("cursor-3");

  await tree.unmount();
});

/**
 * The handoff window, at its smallest: the replay carries a Message the read already had and
 * one it did not. One reducer sorts both out, which is why the hooks have no dedup of their own.
 */
test("a replayed Message the Snapshot already had is absorbed, and a new one lands", async () => {
  const tree = await mount(
    app(<Room snapshot={snapshotOf("cursor-3", messagesOf("one", "two"))} />),
  );
  await flush();

  await act(() => {
    opened[0]?.ready({ cursor: "cursor-3", refused: [] });
    opened[0]?.message("chat:42", "message", { id: "2", text: "two" }, "cursor-4");
    opened[0]?.message("chat:42", "message", { id: "3", text: "three" }, "cursor-5");
    opened[0]?.caughtUp();
  });

  expect(texts(tree)).toEqual(["one", "two", "three"]);

  await tree.unmount();
});

test("the statuses are replaying while it catches up, then live", async () => {
  const tree = await mount(app(<Room snapshot={snapshotOf("cursor-3", messagesOf("one"))} />));
  await flush();
  const status = () => tree.container.querySelector("div")?.dataset.status;

  expect(status()).toBe("connecting");

  await act(() => {
    opened[0]?.ready({ cursor: "cursor-3", refused: [] });
  });

  expect(status()).toBe("replaying");

  await act(() => {
    opened[0]?.caughtUp();
  });

  expect(status()).toBe("live");

  await tree.unmount();
});

/**
 * What a Reset costs the App: nothing. The provider refreshed the route, the server component
 * read again at a fresh Cursor, and the new prop restarts the hook — state and Connection both.
 */
test("a new Snapshot prop restarts the state and reopens from the new position", async () => {
  function Refreshing() {
    const [snapshot, setSnapshot] = useState(snapshotOf("cursor-3", messagesOf("one")));

    return (
      <>
        <Room snapshot={snapshot} />
        <button
          onClick={() => setSnapshot(snapshotOf("cursor-9", messagesOf("after the refetch")))}
        >
          refresh
        </button>
      </>
    );
  }
  const tree = await mount(app(<Refreshing />));
  await flush();
  await act(() => {
    opened[0]?.message("chat:42", "message", { id: "5", text: "live" }, "cursor-5");
  });

  await click(tree.container, "refresh");
  await flush();

  expect(texts(tree)).toEqual(["after the refetch"]);
  expect(opened).toHaveLength(2);
  expect(opened[1]?.cursor).toBe("cursor-9");

  await tree.unmount();
});

/** `apply` is the same reducer, run on something that did not come off the wire. */
test("apply runs a reducer here and now, and the Message's echo is absorbed", async () => {
  const tree = await mount(app(<Room snapshot={snapshotOf("cursor-3", messagesOf("one"))} />));
  await flush();

  await click(tree.container, "apply");

  expect(texts(tree)).toEqual(["one", "applied"]);

  await act(() => {
    opened[0]?.caughtUp();
    opened[0]?.message("chat:42", "message", { id: "9", text: "applied" }, "cursor-4");
  });

  expect(texts(tree)).toEqual(["one", "applied"]);

  await tree.unmount();
});

/**
 * `act` is the whole optimistic round: the payload shows in `pending` — with the event's own
 * wire shape — for as long as the action runs, `inFlight` says so, and the result is applied
 * before the transition ends, so the row never blinks.
 */
test("act shows an optimistic payload while it runs, then applies what came back", async () => {
  const tree = await mount(app(<Room snapshot={snapshotOf("cursor-3", messagesOf("one"))} />));
  await flush();

  await click(tree.container, "send");

  expect(texts(tree, "ol")).toEqual(["sending"]);
  expect(tree.container.querySelector("div")?.dataset.inFlight).toBe("true");
  expect(texts(tree)).toEqual(["one"]);

  await act(async () => {
    settle();
    await settled;
  });

  expect(texts(tree)).toEqual(["one", "sent"]);
  expect(texts(tree, "ol")).toEqual([]);
  expect(tree.container.querySelector("div")?.dataset.inFlight).toBe("false");

  await tree.unmount();
});

test("pending carries a list per declared event, empty ones included", async () => {
  const tree = await mount(app(<Room snapshot={snapshotOf("cursor-3")} />));
  await flush();

  expect(texts(tree, "ol")).toEqual([]);

  await tree.unmount();
});

test("an event with no reducer leaves the state where it was", async () => {
  const tree = await mount(app(<Room snapshot={snapshotOf("cursor-3", messagesOf("one"))} />));
  await flush();

  await act(() => {
    opened[0]?.caughtUp();
    opened[0]?.message("chat:42", "typing", { who: "ada" }, "cursor-4");
  });

  expect(texts(tree)).toEqual(["one"]);

  await tree.unmount();
});
