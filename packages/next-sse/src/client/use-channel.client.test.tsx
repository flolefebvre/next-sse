import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";

import { sealSnapshot, type Snapshot } from "../internal/snapshot.js";

import { app, channels, installEventSource, useChannel, type Chat } from "./app.testkit.js";
import type { FakeEventSource } from "./fake-event-source.js";
import { createClient } from "./index.js";
import { act, click, flush, mount, type Mounted } from "./react.testkit.js";

let opened: FakeEventSource[] = [];

beforeEach(() => {
  opened = installEventSource();
});

function Messages({ roomId = "42" }: { roomId?: string }) {
  const [texts, setTexts] = useState<string[]>([]);
  const { status, channel } = useChannel(channels.chat({ roomId }), {
    message: (payload) => setTexts((seen) => [...seen, payload.text]),
  });

  return (
    <p data-channel={channel} data-status={status}>
      {texts.join("|")}
    </p>
  );
}

function Presence() {
  const { channel } = useChannel(channels.presence({ roomId: "42" }), {});

  return <span>{channel}</span>;
}

/** The one Connection there should be, refused if there is any other number of them. */
function only(): FakeEventSource {
  expect(opened).toHaveLength(1);

  return opened[0] as FakeEventSource;
}

test("a mounted hook subscribes to the Channel its Handle resolves to", async () => {
  const tree = await mount(app(<Messages />));
  await flush();

  expect(only().channels).toEqual(["chat:42"]);
  expect(tree.container.querySelector("p")?.dataset.channel).toBe("chat:42");

  await tree.unmount();
});

test("the SSE route is /api/sse unless the provider says otherwise", async () => {
  const tree = await mount(app(<Messages />, { url: "/live/stream" }));
  await flush();

  expect(only().url.startsWith("/live/stream?")).toBe(true);

  await tree.unmount();
});

test("a Message on the Channel reaches the component, and one on another does not", async () => {
  const tree = await mount(app(<Messages />));
  await flush();
  const connection = only();

  await act(() => {
    connection.caughtUp();
    connection.message("chat:42", "message", { text: "hello" });
    connection.message("chat:7", "message", { text: "elsewhere" });
    connection.message("chat:42", "message", { text: "again" });
  });

  expect(tree.container.textContent).toBe("hello|again");

  await tree.unmount();
});

test("an event with no handler is ignored rather than an error", async () => {
  const tree = await mount(app(<Messages />));
  await flush();

  await act(() => {
    only().caughtUp();
    only().message("chat:42", "typing", { who: "ada" });
  });

  expect(tree.container.textContent).toBe("");

  await tree.unmount();
});

test("the status reaches live when the Connection is caught up", async () => {
  const tree = await mount(app(<Messages />));
  await flush();
  const status = () => tree.container.querySelector("p")?.dataset.status;

  expect(status()).toBe("connecting");

  await act(() => {
    only().ready();
    only().caughtUp();
  });

  expect(status()).toBe("live");

  await tree.unmount();
});

test("unmounting unsubscribes: the Connection closes and nothing reaches the component", async () => {
  const tree = await mount(app(<Messages />));
  await flush();
  const connection = only();

  await tree.unmount();
  await flush();

  expect(connection.readyState).toBe(2);
  expect(opened).toHaveLength(1);
});

test("many hooks mounting in one render open exactly one Connection", async () => {
  const tree = await mount(
    app(
      <>
        <Messages />
        <Messages roomId="7" />
        <Presence />
      </>,
    ),
  );
  await flush();

  expect(only().channels).toEqual(["chat:42", "chat:7", "presence:42"]);

  await tree.unmount();
});

/**
 * Strict Mode mounts, unmounts and mounts again in development. The core sees a subscribe, an
 * unsubscribe and a subscribe inside one tick, and coalesces them — there is no development
 * branch anywhere for it to take.
 */
test("a Strict Mode setup, cleanup and setup burst opens exactly one Connection", async () => {
  const tree = await mount(app(<Messages />), { strict: true });
  await flush();

  expect(only().channels).toEqual(["chat:42"]);

  await act(() => {
    only().caughtUp();
    only().message("chat:42", "message", { text: "once" });
  });

  expect(tree.container.textContent).toBe("once");

  await tree.unmount();
});

test("a re-render with fresh handler closures keeps the Connection it has", async () => {
  function Rerendering() {
    const [, force] = useState(0);

    return (
      <>
        <Messages />
        <button onClick={() => force((count) => count + 1)}>render</button>
      </>
    );
  }
  const tree = await mount(app(<Rerendering />));
  await flush();

  await click(tree.container, "render");
  await flush();

  expect(opened).toHaveLength(1);

  await tree.unmount();
});

test("a Handle for a Channel the provider does not carry is an error that names it", async () => {
  const unknown = createClient<{ channels: { nope: Chat } }>();
  function Nope() {
    unknown.useChannel(unknown.channels.nope({ roomId: "42" }), {});

    return null;
  }

  await expect(mount(app(<Nope />))).rejects.toThrow(/no Channel "nope"/);
});

test("a Handle missing a param of its pattern is an error, not a Channel with a brace in it", async () => {
  function Unfilled() {
    // @ts-expect-error the compiler asks for the param; this is what an untyped caller hits
    useChannel(channels.chat(), {});

    return null;
  }

  await expect(mount(app(<Unfilled />))).rejects.toThrow(/roomId/);
});

test("a hook with no provider above it says what to mount", async () => {
  await expect(mount(<Messages />)).rejects.toThrow(/<SSEProvider>/);
});

/**
 * A mounted hook on a live Connection, opened the way the Instance opens one: `ready` carrying
 * the Cursor it settled on, then `caught-up`. The jitter is pinned to zero so that the core's
 * own retry fires on the next tick rather than up to a second later, which is what lets a
 * reconnect be driven here with no timer control at all.
 */
const liveOn = async (cursor: string): Promise<Mounted> => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const tree = await mount(app(<Messages />));
  await flush();

  await act(() => {
    only().ready({ cursor, refused: [] });
    only().caughtUp();
  });

  return tree;
};

/**
 * The gap-free guarantee as a component sees it. The Connection the browser gave up on is
 * reopened by the core with the id of the last Message that reached the hook, and the Instance
 * replays strictly after it — so the list gains what was published while the client was away,
 * in order, and repeats nothing it already had.
 */
test("a Connection the core reopens resumes from its Cursor: nothing lost, nothing twice", async () => {
  const tree = await liveOn("c0");

  await act(() => {
    only().message("chat:42", "message", { text: "one" }, "c1");
    only().message("chat:42", "message", { text: "two" }, "c2");
  });

  expect(tree.container.textContent).toBe("one|two");

  await act(() => {
    only().fail();
  });
  await flush();

  const resumed = opened[1] as FakeEventSource;
  expect(resumed.cursor).toBe("c2");

  await act(() => {
    resumed.ready({ cursor: "c2", refused: [] });
    resumed.message("chat:42", "message", { text: "three" }, "c3");
    resumed.caughtUp();
    resumed.message("chat:42", "message", { text: "four" }, "c4");
  });

  expect(tree.container.textContent).toBe("one|two|three|four");

  await tree.unmount();
});

/**
 * The live-only case of ADR-0004: this hook never received a Message, so the only position it
 * has is the tail the Instance put in `ready` — and carrying it is what keeps the reconnect
 * window from swallowing a Message on a Channel that had been quiet.
 */
test("a hook that never received a Message still reconnects from the Cursor ready gave it", async () => {
  const tree = await liveOn("the-tail");

  await act(() => {
    only().fail();
  });
  await flush();

  const resumed = opened[1] as FakeEventSource;
  expect(resumed.cursor).toBe("the-tail");

  await act(() => {
    resumed.ready({ cursor: "the-tail", refused: [] });
    resumed.message("chat:42", "message", { text: "published while it was away" }, "c1");
    resumed.caughtUp();
  });

  expect(tree.container.textContent).toBe("published while it was away");

  await tree.unmount();
});

/**
 * The low-level half of the handoff (ADR-0007): the component takes the Snapshot its server
 * component handed it, gives it to the hook, and the Connection resumes from the position that
 * render read its data at. Nothing here spells out a Cursor — the component cannot, and that is
 * the point of the Snapshot being opaque.
 */
function Resuming({ snapshot }: { snapshot: Snapshot<string[]> }) {
  const [texts, setTexts] = useState(snapshot.data);
  useChannel(
    channels.chat({ roomId: "42" }),
    { message: (payload) => setTexts((seen) => [...seen, payload.text]) },
    { snapshot },
  );

  return <p>{texts.join("|")}</p>;
}

test("a hook that brings a Snapshot resumes its Connection from inside it", async () => {
  const tree = await mount(app(<Resuming snapshot={sealSnapshot("cursor-3", ["read"])} />));
  await flush();

  expect(only().cursor).toBe("cursor-3");
  expect(tree.container.textContent).toBe("read");

  await tree.unmount();
});

/**
 * A replay answers the Cursor somebody brought, and is a duplicate to everybody else. The hook
 * that asked for it is fed it; the one that brought no Snapshot hears nothing until the
 * Connection is live, because it has no way to tell what it already has.
 */
test("the replay reaches the hook that brought a Snapshot, and not the live-only one", async () => {
  const tree = await mount(
    app(
      <>
        <Resuming snapshot={sealSnapshot("cursor-3", ["read"])} />
        <Messages />
      </>,
    ),
  );
  await flush();

  await act(() => {
    only().ready({ cursor: "cursor-3", refused: [] });
    only().message("chat:42", "message", { text: "replayed" }, "cursor-4");
    only().caughtUp();
    only().message("chat:42", "message", { text: "live" }, "cursor-5");
  });

  expect(tree.container.querySelector("p")?.textContent).toBe("read|replayed|live");
  expect(tree.container.querySelectorAll("p")[1]?.textContent).toBe("live");

  await tree.unmount();
});

/**
 * What a Reset costs once the refetch has happened: the refreshed server component minted a new
 * Snapshot, the new prop reaches the hook, and the Connection reopens from that position. One
 * reconnect, and the reducers of whatever holds the state absorb the overlap.
 */
test("a new Snapshot prop reopens the Connection from the new position", async () => {
  function Refreshing() {
    const [snapshot, setSnapshot] = useState(sealSnapshot("cursor-3", ["read"]));

    return (
      <>
        <Resuming snapshot={snapshot} />
        <button onClick={() => setSnapshot(sealSnapshot("cursor-9", ["read again"]))}>
          refresh
        </button>
      </>
    );
  }
  const tree = await mount(app(<Refreshing />));
  await flush();

  await click(tree.container, "refresh");
  await flush();

  expect(opened).toHaveLength(2);
  expect(opened[1]?.cursor).toBe("cursor-9");

  await tree.unmount();
});
