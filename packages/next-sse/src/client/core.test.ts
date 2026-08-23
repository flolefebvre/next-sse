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

/** One subscriber, with everything it was told recorded in the order it was told. */
function recorder(channel: string): Subscription & {
  messages: { event: string; payload: unknown }[];
  statuses: Status[];
} {
  const messages: { event: string; payload: unknown }[] = [];
  const statuses: Status[] = [];

  return {
    channel,
    messages,
    statuses,
    onMessage: (event, payload) => messages.push({ event, payload }),
    onStatus: (status) => statuses.push(status),
  };
}

const setup = () => {
  const { EventSource, opened } = fakeEventSources();

  return { core: createCore({ url: "/api/sse", eventSource: EventSource }), opened };
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

  only(opened).message("chat:42", "message", { text: "hello" }, "cursor-1");

  expect(here.messages).toEqual([{ event: "message", payload: { text: "hello" } }]);
  expect(alsoHere.messages).toEqual(here.messages);
  expect(elsewhere.messages).toEqual([]);
});

test("a Message carries whatever event name it was published on", async () => {
  const { core, opened } = setup();
  const subscriber = recorder("chat:42");
  core.subscribe(subscriber);
  await tick();

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
  const { core, opened } = setup();
  const subscriber = recorder("chat:42");
  core.subscribe(subscriber);
  await tick();

  only(opened).ready();
  only(opened).caughtUp();
  only(opened).caughtUp();

  expect(subscriber.statuses).toEqual(["live"]);
});

test("a hook mounting onto a live Connection that already carries its Channel is live at once", async () => {
  const { core, opened } = setup();
  core.subscribe(recorder("chat:42"));
  await tick();
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
  const { core, opened } = setup();
  const subscriber = recorder("chat:42");
  core.subscribe(subscriber);
  await tick();
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
 * Cursor — and `reset`, which the App's own handling belongs to another ticket, leaves the
 * Connection exactly where it was.
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
