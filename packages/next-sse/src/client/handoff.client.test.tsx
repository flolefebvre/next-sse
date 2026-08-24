import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";

import type { Snapshot } from "../internal/snapshot.js";

import {
  app,
  channels,
  installEventSource,
  snapshotOf,
  useChannelState,
  type Message,
} from "./app.testkit.js";
import type { FakeEventSource } from "./fake-event-source.js";
import { upsertBy } from "./index.js";
import { act, click, flush, hydrate } from "./react.testkit.js";

/**
 * The handoff, end to end and by enumeration: a server component reads its data, hands the
 * client one Snapshot, the markup is hydrated, and the Connection resumes from the position the
 * read was taken at.
 *
 * The window is the interval between that Cursor and the stream going live, and a Message
 * published inside it can reach this page three ways: the read saw it, the replay carried it,
 * the live feed carried it. Any of the seven combinations is possible in a real deployment —
 * that is what an ordered log with an inclusive replay and a server-side cut leaves open — and
 * the promise is the same for all of them: the Message appears exactly once, in order, with
 * nothing lost. One `upsertBy` reducer is the whole of what the App writes for it.
 */
const BEFORE: Message = { id: "1", text: "before the window" };
const WINDOWED: Message = { id: "2", text: "inside the window" };

let opened: FakeEventSource[] = [];

beforeEach(() => {
  opened = installEventSource();
});

function Room({ snapshot, roomId = "42" }: { snapshot: Snapshot<Message[]>; roomId?: string }) {
  const { state, status } = useChannelState(channels.chat({ roomId }), snapshot, {
    message: upsertBy("id"),
  });

  return (
    <ul data-room={roomId} data-status={status}>
      {state.map((message) => (
        <li key={message.id}>{message.text}</li>
      ))}
    </ul>
  );
}

const texts = (container: HTMLElement, room = "42") =>
  Array.from(container.querySelectorAll(`[data-room="${room}"] li`), (item) => item.textContent);

/** Every way a Message published inside the handoff window can reach the page, minus none. */
const DELIVERIES = [
  { read: true, replayed: false, live: false },
  { read: false, replayed: true, live: false },
  { read: false, replayed: false, live: true },
  { read: true, replayed: true, live: false },
  { read: true, replayed: false, live: true },
  { read: false, replayed: true, live: true },
  { read: true, replayed: true, live: true },
];

test.for(DELIVERIES)(
  "a Message inside the handoff window appears exactly once (read %o)",
  async (delivery) => {
    const tree = await hydrate(
      app(
        <Room snapshot={snapshotOf("cursor-3", delivery.read ? [BEFORE, WINDOWED] : [BEFORE])} />,
      ),
    );
    await flush();
    const connection = opened[0] as FakeEventSource;

    await act(() => {
      connection.ready({ cursor: "cursor-3", refused: [] });
      if (delivery.replayed) connection.message("chat:42", "message", WINDOWED, "cursor-4");
      connection.caughtUp();
      if (delivery.live) connection.message("chat:42", "message", WINDOWED, "cursor-5");
    });

    expect(texts(tree.container)).toEqual([BEFORE.text, WINDOWED.text]);

    await tree.unmount();
  },
);

/**
 * What the reader sees before any of this: the server's own markup. React adopting it without
 * complaint is the claim — a Snapshot that did not survive the boundary, or a hook that seeded
 * itself from something else, would show up here as a hydration mismatch and nowhere else.
 */
test("the list is server-rendered markup, adopted by hydration without a mismatch", async () => {
  const complaints = vi.spyOn(console, "error").mockImplementation(() => undefined);

  const tree = await hydrate(app(<Room snapshot={snapshotOf("cursor-3", [BEFORE])} />));

  expect(texts(tree.container)).toEqual([BEFORE.text]);
  expect(complaints).not.toHaveBeenCalled();
  expect(opened).toHaveLength(0);

  await flush();

  expect(opened[0]?.cursor).toBe("cursor-3");

  await tree.unmount();
});

/**
 * One render, one Cursor (ADR-0007): `sse.cursor()` is cached per request, so every server
 * component of a page hands down the same position and the client opens one Connection for all
 * of them — the reconnect a page pays for its Snapshots is one, not one per Snapshot.
 */
test("several Snapshots of one render cost one Connection, and one reconnect", async () => {
  const first = snapshotOf("cursor-3", [BEFORE]);
  const tree = await hydrate(
    app(
      <>
        <Room snapshot={first} />
        <Room snapshot={snapshotOf("cursor-3")} roomId="7" />
      </>,
    ),
  );
  await flush();

  expect(opened).toHaveLength(1);
  expect(opened[0]?.cursor).toBe("cursor-3");
  expect(opened[0]?.channels).toEqual(["chat:42", "chat:7"]);

  await tree.unmount();
});

/**
 * The cost ADR-0007 accepts, and the reason `upsertBy` is not optional: a hook arriving with a
 * Cursor reopens the Connection everybody shares, so the hooks already on it are replayed
 * Messages they had. The reducer absorbs them, and the list of the hook that was there all
 * along does not move.
 */
test("a hook arriving with a Cursor reopens the shared Connection, duplicates and all", async () => {
  /**
   * Room 42's Snapshot is taken once and never replaced: without that, opening the other room
   * would re-render it with a new Snapshot object, restart its state, and the duplicate this
   * test is about would be absorbed by the restart rather than by the reducer.
   */
  const first = snapshotOf("cursor-3", [BEFORE]);
  function Page() {
    const [late, setLate] = useState(false);

    return (
      <>
        <Room snapshot={first} />
        {late && <Room snapshot={snapshotOf("cursor-9")} roomId="7" />}
        <button onClick={() => setLate(true)}>open the other room</button>
      </>
    );
  }
  const tree = await hydrate(app(<Page />));
  await flush();

  await act(() => {
    opened[0]?.ready({ cursor: "cursor-3", refused: [] });
    opened[0]?.caughtUp();
    opened[0]?.message("chat:42", "message", WINDOWED, "cursor-9");
  });

  expect(texts(tree.container)).toEqual([BEFORE.text, WINDOWED.text]);

  await click(tree.container, "open the other room");
  await flush();

  expect(opened).toHaveLength(2);
  expect(opened[1]?.cursor).toBe("cursor-9");
  expect(opened[1]?.channels).toEqual(["chat:42", "chat:7"]);

  await act(() => {
    opened[1]?.ready({ cursor: "cursor-9", refused: [] });
    opened[1]?.message("chat:42", "message", WINDOWED, "cursor-10");
    opened[1]?.caughtUp();
  });

  expect(texts(tree.container)).toEqual([BEFORE.text, WINDOWED.text]);
  expect(texts(tree.container, "7")).toEqual([]);

  await tree.unmount();
});
