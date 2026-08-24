import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createCore, type Core, type Status, type Subscription } from "./core.js";
import { fakeEventSources, type FakeEventSource } from "./fake-event-source.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the macrotask tick the core coalesces on pass. */
const tick = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/**
 * One subscriber, with everything it was told recorded in the order it was told. `cursor` is
 * the Snapshot a hook brought, and `onReset` the handler it brought instead of the App-wide one.
 */
function recorder(
  channel: string,
  { cursor, onReset }: { cursor?: string; onReset?: () => void } = {},
): Subscription & {
  messages: { event: string; payload: unknown }[];
  statuses: Status[];
} {
  const messages: { event: string; payload: unknown }[] = [];
  const statuses: Status[] = [];

  return {
    channel,
    cursor,
    messages,
    statuses,
    onMessage: (event, payload) => messages.push({ event, payload }),
    onStatus: (status) => statuses.push(status),
    ...(onReset === undefined ? {} : { onReset }),
  };
}

const setup = (onReset?: () => void) => {
  const { EventSource, opened } = fakeEventSources();

  return {
    core: createCore({ url: "/api/sse", eventSource: EventSource, onReset }),
    opened,
  };
};

/**
 * One subscriber on its Connection, with the tick the core coalesces on already past: where
 * most of these tests actually begin.
 */
const subscribed = async (options: { cursor?: string } = {}) => {
  const { core, opened } = setup();
  const subscriber = recorder("chat:42", options);
  core.subscribe(subscriber);
  await tick();

  return { core, opened, subscriber };
};

/** The one Connection there should be, refused if there is any other number of them. */
function only(opened: FakeEventSource[]): FakeEventSource {
  expect(opened).toHaveLength(1);

  return opened[0] as FakeEventSource;
}

test("a subscription opens one Connection, on the next tick, naming its Channel", async () => {
  const { core, opened } = setup();

  core.subscribe(recorder("chat:42"));

  expect(opened).toHaveLength(0);

  await tick();

  expect(only(opened).url).toBe("/api/sse?channel=chat%3A42");
  expect(only(opened).channels).toEqual(["chat:42"]);
});

test("many subscriptions in one tick open exactly one Connection carrying every Channel", async () => {
  const { core, opened } = setup();

  core.subscribe(recorder("chat:42"));
  core.subscribe(recorder("chat:7"));
  core.subscribe(recorder("presence:42"));

  await tick();

  expect(only(opened).channels).toEqual(["chat:42", "chat:7", "presence:42"]);
});

/**
 * The Strict Mode burst, at the level the core sees it: setup → cleanup → setup within one
 * tick. Nothing here knows about Strict Mode, which is exactly why there is no branch for it.
 */
test("a subscribe, unsubscribe and subscribe within one tick opens one Connection", async () => {
  const { core, opened } = setup();

  core.subscribe(recorder("chat:42"))();
  core.subscribe(recorder("chat:42"));

  await tick();

  expect(only(opened).channels).toEqual(["chat:42"]);
});

test("a repeated Channel is one Channel on the Connection", async () => {
  const { core, opened } = setup();

  core.subscribe(recorder("chat:42"));
  core.subscribe(recorder("chat:42"));

  await tick();

  expect(only(opened).channels).toEqual(["chat:42"]);
});

test("a Message reaches the subscribers of its Channel, and only those", async () => {
  const { core, opened } = setup();
  const here = recorder("chat:42");
  const alsoHere = recorder("chat:42");
  const elsewhere = recorder("chat:7");
  core.subscribe(here);
  core.subscribe(alsoHere);
  core.subscribe(elsewhere);
  await tick();
  only(opened).caughtUp();

  only(opened).message("chat:42", "message", { text: "hello" }, "cursor-1");

  expect(here.messages).toEqual([{ event: "message", payload: { text: "hello" } }]);
  expect(alsoHere.messages).toEqual(here.messages);
  expect(elsewhere.messages).toEqual([]);
});

test("a Message carries whatever event name it was published on", async () => {
  const { opened, subscriber } = await subscribed();
  only(opened).caughtUp();

  only(opened).message("chat:42", "typing", { who: "ada" });

  expect(subscriber.messages).toEqual([{ event: "typing", payload: { who: "ada" } }]);
});

test("an unsubscribed hook is fed nothing, and the last one out closes the Connection", async () => {
  const { core, opened } = setup();
  const subscriber = recorder("chat:42");
  const unsubscribe = core.subscribe(subscriber);
  await tick();
  const connection = only(opened);

  unsubscribe();
  await tick();

  expect(connection.readyState).toBe(2);
  connection.message("chat:42", "message", { text: "too late" });
  expect(subscriber.messages).toEqual([]);
  expect(opened).toHaveLength(1);
});

/**
 * `connecting` is where every subscriber starts, so it is never reported: the first thing a
 * hook hears about is a change.
 */
test("a Connection reaches live on caught-up, and says so once", async () => {
  const { opened, subscriber } = await subscribed();

  only(opened).ready();
  only(opened).caughtUp();
  only(opened).caughtUp();

  expect(subscriber.statuses).toEqual(["live"]);
});

test("a hook mounting onto a live Connection that already carries its Channel is live at once", async () => {
  const { core, opened } = await subscribed();
  only(opened).caughtUp();

  const late = recorder("chat:42");
  core.subscribe(late);

  expect(late.statuses).toEqual(["live"]);

  await tick();

  expect(opened).toHaveLength(1);
});

test("a Channel nobody was subscribed to reopens the Connection with both", async () => {
  const { core, opened } = setup();
  core.subscribe(recorder("chat:42"));
  await tick();
  const first = only(opened);
  first.caughtUp();

  core.subscribe(recorder("chat:7"));
  await tick();

  expect(first.readyState).toBe(2);
  expect(opened).toHaveLength(2);
  expect(opened[1]?.channels).toEqual(["chat:42", "chat:7"]);
});

/**
 * The ordinary transient drop: the pipe broke and the browser's own timer is already bringing
 * it back, with `Last-Event-ID` for free. The core watches this one; taking it over would cost
 * the unthrottled native retry for nothing (ADR-0004).
 */
test("a dropped pipe is the browser's to retry: the core reports it and opens nothing", async () => {
  const { opened, subscriber } = await subscribed();
  only(opened).caughtUp();

  only(opened).drop();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(subscriber.statuses).toEqual(["live", "reconnecting"]);
  expect(opened).toHaveLength(1);
});

test("a Connection the browser gave up on is the core's to retry, backing off to a 30s cap", async () => {
  vi.spyOn(Math, "random").mockReturnValue(1);
  const { core, opened } = setup();
  const subscriber = recorder("chat:42");
  core.subscribe(subscriber);
  await tick();

  const delays: number[] = [];
  for (const wait of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
    const before = opened.length;
    opened[before - 1]?.fail();
    await vi.advanceTimersByTimeAsync(wait - 1);
    if (opened.length === before) {
      await vi.advanceTimersByTimeAsync(1);
      delays.push(wait);
    }
  }

  expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
  expect(opened).toHaveLength(8);
  expect(opened[7]?.channels).toEqual(["chat:42"]);
  expect(subscriber.statuses).toEqual(["reconnecting"]);
});

/**
 * The state every retry test starts from: a Connection the browser gave up on, with the core's
 * own timer already counting down and the jitter pinned so the delay is the cap.
 */
async function retrying(): Promise<{
  core: Core;
  opened: FakeEventSource[];
  unsubscribe: () => void;
}> {
  vi.spyOn(Math, "random").mockReturnValue(1);
  const { core, opened } = setup();
  const unsubscribe = core.subscribe(recorder("chat:42"));
  await tick();
  opened[0]?.fail();

  return { core, opened, unsubscribe };
}

test("a Connection that comes back starts the next backoff from one second again", async () => {
  const { opened } = await retrying();

  await vi.advanceTimersByTimeAsync(1000);
  opened[1]?.fail();
  await vi.advanceTimersByTimeAsync(2000);
  opened[2]?.ready();
  opened[2]?.fail();
  await vi.advanceTimersByTimeAsync(999);

  expect(opened).toHaveLength(3);

  await vi.advanceTimersByTimeAsync(1);

  expect(opened).toHaveLength(4);
});

test("a retry the last hook left behind is cancelled, not fired at nobody", async () => {
  const { opened, unsubscribe } = await retrying();

  unsubscribe();
  await tick();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(opened).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("a subscription arriving during a retry does not wait for it", async () => {
  const { core, opened } = await retrying();

  core.subscribe(recorder("chat:7"));
  await tick();

  expect(opened).toHaveLength(2);
  expect(opened[1]?.channels).toEqual(["chat:42", "chat:7"]);

  await vi.advanceTimersByTimeAsync(60_000);

  expect(opened).toHaveLength(2);
});

test("an error on a Connection the core has already replaced changes nothing", async () => {
  const { core, opened } = setup();
  const subscriber = recorder("chat:42");
  core.subscribe(subscriber);
  await tick();
  const first = only(opened);

  core.subscribe(recorder("chat:7"));
  await tick();
  first.fail();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(opened).toHaveLength(2);
  expect(subscriber.statuses).toEqual([]);
});

/**
 * A Connection that knows where it is: `ready` settled its position, and one Message has moved
 * it on. This is the state every case about carrying the Cursor starts from.
 */
async function positioned(): Promise<{
  core: Core;
  opened: FakeEventSource[];
  subscriber: ReturnType<typeof recorder>;
}> {
  const { core, opened } = setup();
  const subscriber = recorder("chat:42");
  core.subscribe(subscriber);
  await tick();
  only(opened).ready({ cursor: "cursor-7", refused: [] });
  only(opened).message("chat:42", "message", { text: "one" }, "cursor-8");

  return { core, opened, subscriber };
}

test("the first Connection carries no Cursor, and the next one carries what ready gave it", async () => {
  const { core, opened } = setup();
  core.subscribe(recorder("chat:42"));
  await tick();

  expect(opened[0]?.cursor).toBe(null);

  only(opened).ready({ cursor: "cursor-7", refused: [] });
  only(opened).fail();
  await vi.advanceTimersByTimeAsync(1000);

  expect(opened[1]?.cursor).toBe("cursor-7");
});

test("the id of the last Message is what the next Connection resumes from", async () => {
  const { opened } = await positioned();

  only(opened).message("chat:42", "message", { text: "two" }, "cursor-9");
  only(opened).fail();
  await vi.advanceTimersByTimeAsync(1000);

  expect(opened[1]?.cursor).toBe("cursor-9");
});

/**
 * Every Connection the core opens carries the Cursor, whatever made it open: a Channel-set
 * change is a reconnect like any other, and a Message published while it happens must not be
 * lost because the new Connection came up live-only.
 */
test("a Channel-set change carries the Cursor, exactly like a retry does", async () => {
  const { core, opened } = await positioned();

  core.subscribe(recorder("chat:7"));
  await tick();

  expect(opened[1]?.channels).toEqual(["chat:42", "chat:7"]);
  expect(opened[1]?.cursor).toBe("cursor-8");
});

/**
 * The Cursor is opaque here (ADR-0001): the core has no way to tell whether one is older than
 * another, and no reason to — the Instance settles the position and says so in `ready`.
 */
test("the core carries the Cursor it was last given, without comparing it to the one it had", async () => {
  const { core, opened } = setup();
  core.subscribe(recorder("chat:42"));
  await tick();
  only(opened).message("chat:42", "message", { text: "one" }, "zzz-9");

  core.subscribe(recorder("chat:7"));
  await tick();
  opened[1]?.ready({ cursor: "aaa-1", refused: [] });
  opened[1]?.fail();
  await vi.advanceTimersByTimeAsync(1000);

  expect(opened[2]?.cursor).toBe("aaa-1");
});

/**
 * Control events are not positions (ADR-0004): they carry no `id:`, so none of them moves the
 * Cursor — and `reset`, whatever refetch it sets off above, leaves the Connection exactly where
 * it was.
 */
test("no Control event moves the Cursor, reset included", async () => {
  const { opened, subscriber } = await positioned();

  only(opened).emit("reset");
  only(opened).caughtUp();
  only(opened).emit("heartbeat");
  only(opened).fail();
  await vi.advanceTimersByTimeAsync(1000);

  expect(opened[1]?.cursor).toBe("cursor-8");
  expect(subscriber.statuses).toEqual(["live", "reconnecting"]);
});

/**
 * The Snapshot handoff, at the level the core sees it: a subscriber arrives holding the
 * position a server component read its data at, and the Connection it lands on resumes from
 * there. On a first mount that is the only Connection there ever was — the handoff costs no
 * reconnect at all when the page had none open.
 */
test("a subscription that brings a Cursor opens its Connection from it", async () => {
  const { core, opened } = setup();

  core.subscribe(recorder("chat:42", { cursor: "snapshot-1" }));
  await tick();

  expect(only(opened).cursor).toBe("snapshot-1");
});

/**
 * The reconnect ADR-0007 pays for: the Channel set has not changed, so nothing in the
 * Channel-set rule would reopen anything, and the Cursor alone does it.
 */
test("a Cursor arriving on a live Connection reopens it, Channel set unchanged", async () => {
  const { core, opened } = setup();
  core.subscribe(recorder("chat:42"));
  await tick();
  only(opened).ready({ cursor: "tail", refused: [] });
  only(opened).caughtUp();

  core.subscribe(recorder("chat:42", { cursor: "snapshot-1" }));
  await tick();

  expect(opened).toHaveLength(2);
  expect(opened[0]?.readyState).toBe(2);
  expect(opened[1]?.cursor).toBe("snapshot-1");
  expect(opened[1]?.channels).toEqual(["chat:42"]);
});

/**
 * Strict Mode with a Snapshot in hand: setup → cleanup → setup, all inside one tick, all
 * carrying the same Cursor. The tick the core coalesces on is what makes that one Connection;
 * there is no second reopen to be found, and no development branch that avoids one.
 */
test("re-subscribing with the same Cursor inside one tick opens one Connection", async () => {
  const { core, opened } = setup();

  const leave = core.subscribe(recorder("chat:42", { cursor: "snapshot-1" }));
  leave();
  core.subscribe(recorder("chat:42", { cursor: "snapshot-1" }));
  await tick();

  expect(only(opened).cursor).toBe("snapshot-1");
});

/**
 * Two Snapshots, two different Cursors, one tick. The core cannot order them — it must never
 * learn how (ADR-0001) — so the rule is stated rather than computed: the last one parked wins.
 * One render's Snapshots share one request-cached Cursor, so this is the case where a page
 * mixes a fresh render with an older one, and its cost is a replay the reducers absorb.
 */
test("two Cursors parked on one tick: the last one wins, and there is one Connection", async () => {
  const { core, opened } = setup();

  core.subscribe(recorder("chat:42", { cursor: "older" }));
  core.subscribe(recorder("chat:7", { cursor: "newer" }));
  await tick();

  expect(only(opened).cursor).toBe("newer");
  expect(only(opened).channels).toEqual(["chat:42", "chat:7"]);
});

/** Leaving is never a reason to reopen: the Channel-set rule alone decides what a departure costs. */
test("a subscriber that brought a Cursor reopens nothing when it leaves", async () => {
  const { core, opened } = setup();
  core.subscribe(recorder("chat:42"));
  const leave = core.subscribe(recorder("chat:42", { cursor: "snapshot-1" }));
  await tick();

  leave();
  await tick();

  expect(only(opened).cursor).toBe("snapshot-1");
});

/**
 * The statuses of ADR-0007. `replaying` is what a Connection that brought a position is doing
 * between `ready` and `caught-up`; a live-only Connection has nothing to replay and never
 * claims to.
 */
test("a Connection that carried a Cursor is replaying on ready and live on caught-up", async () => {
  const { opened, subscriber } = await subscribed({ cursor: "snapshot-1" });

  only(opened).ready({ cursor: "snapshot-1", refused: [] });

  expect(subscriber.statuses).toEqual(["replaying"]);

  only(opened).caughtUp();

  expect(subscriber.statuses).toEqual(["replaying", "live"]);
});

test("a live-only Connection never says replaying", async () => {
  const { opened, subscriber } = await subscribed();

  only(opened).ready();
  only(opened).caughtUp();

  expect(subscriber.statuses).toEqual(["live"]);
});

/**
 * A replay is answering somebody's Cursor, and it is a duplicate to everybody else: a
 * subscriber that brought none cannot tell a replayed Message from one it already has, so it
 * is told nothing until the Connection is live (ADR-0007). After that first `caught-up` it is
 * an ordinary subscriber, and a later replay reaches it like any other Message — which is the
 * duplicate the App's reducers are there to absorb.
 */
test("a replay reaches the subscriber that asked for it, and no live-only one", async () => {
  const { core, opened } = setup();
  const resuming = recorder("chat:42", { cursor: "snapshot-1" });
  const liveOnly = recorder("chat:42");
  core.subscribe(resuming);
  core.subscribe(liveOnly);
  await tick();

  only(opened).ready({ cursor: "snapshot-1", refused: [] });
  only(opened).message("chat:42", "message", { text: "replayed" }, "cursor-1");
  only(opened).caughtUp();
  only(opened).message("chat:42", "message", { text: "live" }, "cursor-2");

  expect(resuming.messages.map((message) => message.payload)).toEqual([
    { text: "replayed" },
    { text: "live" },
  ]);
  expect(liveOnly.messages.map((message) => message.payload)).toEqual([{ text: "live" }]);
});

test("a subscriber that lived through a caught-up is fed the next Connection's replay", async () => {
  const { core, opened, subscriber: liveOnly } = await subscribed();
  only(opened).ready();
  only(opened).caughtUp();

  core.subscribe(recorder("chat:42", { cursor: "snapshot-1" }));
  await tick();
  opened[1]?.ready({ cursor: "snapshot-1", refused: [] });
  opened[1]?.message("chat:42", "message", { text: "replayed" }, "cursor-1");

  expect(liveOnly.messages.map((message) => message.payload)).toEqual([{ text: "replayed" }]);
});

/**
 * Reset is a refetch, not a status (ADR-0007). A subscriber that brought its own handler is
 * the one told; every subscriber that brought none is covered by the Connection's handler —
 * the provider's `router.refresh()` in an ordinary App — called once, so a page of ten hooks
 * that said nothing costs one refetch rather than ten.
 */
test("a reset calls each subscriber's own handler, and the Connection's once for the rest", async () => {
  const appWide = vi.fn();
  const { core, opened } = setup(appWide);
  const own = vi.fn();
  const subscriber = recorder("chat:42", { cursor: "snapshot-1", onReset: own });
  core.subscribe(subscriber);
  core.subscribe(recorder("chat:7"));
  core.subscribe(recorder("presence:42"));
  await tick();

  only(opened).emit("reset");

  expect(own).toHaveBeenCalledTimes(1);
  expect(appWide).toHaveBeenCalledTimes(1);
  expect(subscriber.statuses).toEqual([]);
});

test("a reset every subscriber handles itself never reaches the Connection's handler", async () => {
  const appWide = vi.fn();
  const { core, opened } = setup(appWide);
  core.subscribe(recorder("chat:42", { onReset: vi.fn() }));
  core.subscribe(recorder("chat:7", { onReset: vi.fn() }));
  await tick();

  only(opened).emit("reset");

  expect(appWide).not.toHaveBeenCalled();
});

/**
 * The hole a live-only subscriber would otherwise fall into. It joined a Connection that was
 * already live, so it never lived through a `caught-up` — and if that alone kept it live-only,
 * the replay the browser's own retry brings back would be dropped for it and never offered
 * again. Joining at the live point is what ends live-only, not the next `caught-up`.
 */
test("a subscriber that joined live is fed the replay a native retry brings back", async () => {
  const { core, opened } = await subscribed();
  only(opened).ready();
  only(opened).caughtUp();
  const late = recorder("chat:42");
  core.subscribe(late);
  await tick();

  only(opened).drop();
  only(opened).message("chat:42", "message", { text: "replayed after the drop" }, "cursor-1");

  expect(late.messages.map((message) => message.payload)).toEqual([
    { text: "replayed after the drop" },
  ]);
});

/**
 * A Cursor belongs to the subscriber that brought it, and it leaves with it: a hook that
 * mounted and unmounted inside one tick must not close the Connection everybody else is on and
 * replay a Snapshot nobody is waiting for.
 */
test("a Cursor whose subscriber left before the tick reopens nothing", async () => {
  const { core, opened } = await subscribed();
  only(opened).ready();
  only(opened).caughtUp();

  const leave = core.subscribe(recorder("chat:42", { cursor: "snapshot-1" }));
  leave();
  await tick();

  expect(only(opened).cursor).toBe(null);
});

/**
 * Refusal is per Channel, and that is the whole point of it (ADR-0003): the Connection carries
 * on, the Channels that passed go live, and only the hooks of the refused one are told. Nothing
 * the Connection does afterwards — the replay ending, going live — takes that status back.
 */
test("a refused Channel is refused on its own subscribers, and the rest go live", async () => {
  const { core, opened } = setup();
  const refused = recorder("chat:secret");
  const allowed = recorder("chat:42");
  core.subscribe(refused);
  core.subscribe(allowed);
  await tick();

  only(opened).ready({ cursor: "cursor-0", refused: ["chat:secret"] });
  only(opened).caughtUp();

  expect(refused.statuses).toEqual(["refused"]);
  expect(allowed.statuses).toEqual(["live"]);
});

/**
 * A Connection refused everything is closed here rather than left to the browser: the server
 * ends the stream, and a native `EventSource` would reconnect at once and be told the same thing
 * forever. It is not the core's retry either — that one is for a server that could not answer.
 */
test("a Connection refused every Channel is closed, and nothing retries it", async () => {
  const { core, opened } = setup();
  const one = recorder("chat:42");
  const other = recorder("chat:7");
  core.subscribe(one);
  core.subscribe(other);
  await tick();

  only(opened).ready({ refused: ["chat:42", "chat:7"] });

  expect(only(opened).readyState).toBe(2);
  expect(one.statuses).toEqual(["refused"]);
  expect(other.statuses).toEqual(["refused"]);

  await vi.advanceTimersByTimeAsync(60_000);

  expect(opened).toHaveLength(1);
});

/**
 * The `ready` of an all-refused Connection carries no Cursor, because no Connection was opened
 * to have one. The core keeps the position it already held: there is nothing to fetch here, and
 * nothing to invent.
 */
test("a ready with no Cursor leaves this client's position alone", async () => {
  const { core, opened } = setup();
  const first = recorder("chat:42");
  core.subscribe(first);
  await tick();
  only(opened).ready({ cursor: "cursor-9", refused: [] });
  only(opened).caughtUp();

  core.subscribe(recorder("chat:7"));
  await tick();
  opened[1]?.ready({ refused: ["chat:42", "chat:7"] });

  core.subscribe(recorder("presence:42"));
  await tick();

  expect(opened[2]?.cursor).toBe("cursor-9");
});

/**
 * Authorize runs on every connect, so a Channel refused on one Connection is asked for again on
 * the next: the core never trims the Channel set it requests, and a Kick or a change of role is
 * exactly the case where the answer comes back different.
 */
test("a Connection opened after a refusal asks for the refused Channel again", async () => {
  const { core, opened } = setup();
  core.subscribe(recorder("chat:secret"));
  await tick();
  only(opened).ready({ refused: ["chat:secret"] });

  core.subscribe(recorder("chat:42"));
  await tick();

  expect(opened[1]?.channels).toEqual(["chat:secret", "chat:42"]);
});

/**
 * A reconnect is a fresh Authorize (ADR-0003), so a Channel that was streaming a moment ago can
 * come back refused — which is why `refused` is settable from `live`, not only from `connecting`.
 */
test("a Channel that was live is refused when the next Connection says so", async () => {
  const { core, opened } = setup();
  const streaming = recorder("chat:42");
  core.subscribe(streaming);
  await tick();
  only(opened).ready();
  only(opened).caughtUp();

  expect(streaming.statuses).toEqual(["live"]);

  core.subscribe(recorder("presence:42"));
  await tick();
  opened[1]?.ready({ cursor: "cursor-1", refused: ["chat:42"] });
  opened[1]?.caughtUp();

  expect(streaming.statuses).toEqual(["live", "connecting", "refused"]);
});

/**
 * A hook mounting onto a Connection that already refused its Channel is told so at once. Nothing
 * else would ever tell it: the Channel set has not changed, so no Connection reopens and no
 * second `ready` is coming.
 */
test("a subscriber joining a Connection that refused its Channel is told so", async () => {
  const { core, opened } = setup();
  core.subscribe(recorder("chat:secret"));
  core.subscribe(recorder("chat:42"));
  await tick();
  only(opened).ready({ cursor: "cursor-0", refused: ["chat:secret"] });
  only(opened).caughtUp();

  const late = recorder("chat:secret");
  core.subscribe(late);
  await tick();

  expect(late.statuses).toEqual(["refused"]);
  expect(opened).toHaveLength(1);
});

/**
 * A Reset is the Connection saying its Cursor is gone, and it concerns the Channels that
 * Connection carries. A refused subscriber is not on it, so refetching on its behalf — or
 * refreshing the whole route for it — would be an answer to something that never happened to it.
 */
test("a Reset on a partly refused Connection leaves the refused subscribers alone", async () => {
  const appWide = vi.fn();
  const { EventSource, opened } = fakeEventSources();
  const core = createCore({ url: "/api/sse", eventSource: EventSource, onReset: appWide });
  const own = vi.fn();
  const refused = recorder("chat:secret", { onReset: own });
  core.subscribe(refused);
  core.subscribe(recorder("chat:42", { onReset: own }));
  await tick();
  only(opened).ready({ cursor: "cursor-0", refused: ["chat:secret"] });

  only(opened).emit("reset");

  expect(own).toHaveBeenCalledTimes(1);
  expect(appWide).not.toHaveBeenCalled();
});
