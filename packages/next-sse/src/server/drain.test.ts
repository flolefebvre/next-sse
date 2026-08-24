import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { TransportClosedError } from "../transport/index.js";
import { createMemoryTransport } from "../transport/memory.js";
import type { Transport } from "../transport/index.js";

import { chatApp, type ChatApp } from "./chat-app.testkit.js";
import { framesOf, type Frames } from "./frames.testkit.js";
import { getInstance } from "./instance.js";

/**
 * The Drain, through the real handler: the Connections it ends are Connections a client is
 * holding, so what is asserted here is what the wire carries and what the Connection table does
 * — never a stand-in whose `reconnect` the table would not react to.
 *
 * Every App below configures `drain` explicitly, and the two cases about installation put the
 * process's signal listeners back the way they found them: a suite that leaked one would arm a
 * Drain on the next SIGINT of whoever runs the tests.
 */

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

beforeEach(() => {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  delete globals[Symbol.for("@flefebvre/next-sse")];
});

afterEach(() => {
  vi.useRealTimers();
  removeLeakedListeners();
});

/** The signal listeners this process started the run with: everything else is a test's. */
const before = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal)] as const));

function removeLeakedListeners(): void {
  for (const signal of SIGNALS) {
    for (const listener of process.listeners(signal)) {
      if (!(before.get(signal) ?? []).includes(listener)) process.off(signal, listener);
    }
  }
}

/** How many listeners this test added, per signal. */
function installed(): number[] {
  return SIGNALS.map(
    (signal) =>
      process.listeners(signal).filter((listener) => !(before.get(signal) ?? []).includes(listener))
        .length,
  );
}

/**
 * One App whose Connections nothing else brings to an end: no heartbeat and no max lifetime, so
 * the only thing that ever ends one here is the Drain, and the only `Math.random()` drawn is the
 * Drain's own.
 */
const anApp = (options: { drain?: number | false; transport?: Transport } = {}): ChatApp =>
  chatApp({
    transport: options.transport ?? createMemoryTransport(),
    heartbeat: 0,
    maxLifetime: 0,
    drain: options.drain ?? false,
  });

/** One Connection past its opening sequence, as a client holds it. */
async function connect(sse: ChatApp): Promise<Frames> {
  const frames = await opened(
    await sse.handlers.GET(new Request("http://example.test/api/sse?channel=chat:42")),
  );
  expect((await frames.next()).event).toBe("caught-up");

  return frames;
}

/** The opening every stream shares: a `200`, then `ready` and the retry hint. */
async function opened(response: Response): Promise<Frames> {
  expect(response.status).toBe(200);
  const frames = framesOf(response);
  expect((await frames.next()).event).toBe("ready");
  expect((await frames.next()).retry).toBe("3000");

  return frames;
}

/**
 * How many Connections this Instance is holding. It goes through `getInstance()`, which is a
 * configuration call as much as an accessor — every option it is not given goes back to its
 * default (ADR-0004) — so it is read once a Drain is under way and never before one, where it
 * would put the window back to 3000 under the test that is measuring it.
 */
const held = (): number => getInstance().connections.size;

/**
 * A Transport call held open, for the two cases about the race the Drain has: `opened` resolves
 * when the Instance has reached the call, `release` lets it answer. Nothing here is a branch the
 * library takes in a test — it is the log being slow, which is the whole of what makes the
 * window between passing the handler's check and being registered observable.
 */
interface Gate {
  /** What the Transport call awaits. */
  gate: Promise<void>;
  /** Resolved once the Instance is inside that call. */
  opened: Promise<void>;
  reached: () => void;
  release: () => void;
}

function aGate(): Gate {
  let release = (): void => {};
  let reached = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    reached = resolve;
  });

  return { gate, opened, reached: () => reached(), release: () => release() };
}

/**
 * One connect held inside `open()` — the `gated` Transport call does not answer until the Drain
 * has started — which is the window between passing the handler's check and being registered,
 * made observable. What comes back is what the client saw, and the Drain to wait on.
 */
async function drainMidOpen(
  gated: "subscribe" | "tail",
): Promise<{ response: Response; drained: Promise<void> }> {
  const transport = createMemoryTransport();
  const original = transport[gated].bind(transport) as (...args: never[]) => Promise<never>;
  const { gate, opened: entered, reached, release } = aGate();
  (transport as unknown as Record<string, unknown>)[gated] = async (...args: never[]) => {
    reached();
    await gate;

    return original(...args);
  };
  const sse = anApp({ transport, drain: 0 });

  const connecting = sse.handlers.GET(new Request("http://example.test/api/sse?channel=chat:42"));
  await entered;
  const drained = sse.drain();
  release();

  return { response: await connecting, drained };
}

test("a Drain ends every Connection with reconnect, then closes the Transport", async () => {
  const transport = createMemoryTransport();
  const close = vi.spyOn(transport, "close");
  const sse = anApp({ transport, drain: 0 });
  const client = await connect(sse);

  const drained = sse.drain();

  expect((await client.next()).event).toBe("reconnect");
  await expect(client.next()).rejects.toThrow(/stream ended/);
  await drained;
  expect(held()).toBe(0);
  expect(close).toHaveBeenCalledTimes(1);
});

/**
 * The Transport is closed **after** the last Connection has left the table, and not a moment
 * before: a close that ran first would cut the Connections' own feed and turn a graceful
 * shutdown into the dead socket it exists to prevent (ADR-0011).
 */
test("the Transport is closed only once the Connection table is empty", async () => {
  const transport = createMemoryTransport();
  const order: string[] = [];
  vi.spyOn(transport, "close").mockImplementation(async () => {
    order.push(`close at ${String(held())}`);
  });
  const sse = anApp({ transport, drain: 0 });
  await connect(sse);

  await sse.drain();

  expect(order).toEqual(["close at 0"]);
});

/**
 * Full jitter, per Connection: one Instance's whole table must not re-Authorize and replay
 * against the survivors in the same instant. The draws are fixed here, so the claim is about
 * where each Connection lands in the window rather than about a random number.
 */
test("the Connections are spread over the window, each on a draw of its own", async () => {
  vi.useFakeTimers();
  const sse = anApp({ drain: 1000 });
  await connect(sse);
  await connect(sse);

  vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.9);
  const drained = sse.drain();

  await vi.advanceTimersByTimeAsync(0);
  expect(held()).toBe(1);

  await vi.advanceTimersByTimeAsync(1000);
  expect(held()).toBe(0);
  await drained;
});

/** `0` is a window like any other, and the whole table goes in this tick (ADR-0011). */
test("a window of 0 ends every Connection at once", async () => {
  const sse = anApp({ drain: 0 });
  await connect(sse);
  await connect(sse);

  const drained = sse.drain();

  expect(held()).toBe(0);
  await drained;
});

/**
 * A second signal mid-Drain must join the Drain in flight. Starting a second one would end
 * nothing twice — `reconnect` is idempotent — but it would close the Transport a second time and
 * resolve on a table the first Drain is still emptying.
 */
test("a second Drain, including one started mid-Drain, is the first one", async () => {
  vi.useFakeTimers();
  const transport = createMemoryTransport();
  const close = vi.spyOn(transport, "close");
  const sse = anApp({ transport, drain: 1000 });
  await connect(sse);

  const first = sse.drain();
  const second = sse.drain();
  expect(second).toBe(first);
  expect(held()).toBe(1);

  await vi.advanceTimersByTimeAsync(1000);
  await Promise.all([first, second, sse.drain()]);
  expect(close).toHaveBeenCalledTimes(1);
});

/**
 * The window is what an in-flight server action lands in: it Publishes into a log that is still
 * open, the kicked clients replay it from a survivor, and that is what gap-free across a deploy
 * means. Past the close, a Publish is a rejection rather than a Message nobody will read
 * (ADR-0005).
 */
test("a Publish during the window succeeds, and one after the close is refused", async () => {
  vi.useFakeTimers();
  const sse = anApp({ drain: 1000 });
  await connect(sse);

  const drained = sse.drain();
  await expect(sse.chat({ roomId: "42" }).message({ text: "in flight" })).resolves.toBeTruthy();

  await vi.advanceTimersByTimeAsync(1000);
  await drained;

  await expect(sse.chat({ roomId: "42" }).message({ text: "too late" })).rejects.toBeInstanceOf(
    TransportClosedError,
  );
});

/**
 * Drain is Instance-local by definition: it writes no control Entry, because the log would
 * broadcast it to every Instance and the survivors would drain along with the one that was
 * signalled (ADR-0011).
 */
test("a Drain writes nothing to the log", async () => {
  const transport = createMemoryTransport();
  const sse = anApp({ transport, drain: 0 });
  await connect(sse);
  await sse.chat({ roomId: "42" }).message({ text: "the last thing in the log" });
  const tail = await transport.tail();
  const publish = vi.spyOn(transport, "publish");
  /** The last moment the log can be read: after it, the Transport this App holds is closed. */
  let atClose: string | undefined = undefined;
  const close = transport.close.bind(transport);
  vi.spyOn(transport, "close").mockImplementation(async () => {
    atClose = await transport.tail();
    await close();
  });

  await sse.drain();

  expect(publish).not.toHaveBeenCalled();
  expect(atClose).toBe(tail);
});

/**
 * The race the Drain would otherwise lose: a request that passed the handler's own check and is
 * inside `open()`, waiting on the log, when the flag flips. It is refused where it would have
 * been registered, so the table the Drain walked is the whole of what it has to empty.
 */
test("a Connection still opening when the Drain starts is refused, and never enters the table", async () => {
  const { response, drained } = await drainMidOpen("subscribe");

  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("5");
  expect(held()).toBe(0);
  await drained;
});

/**
 * The other half of the same race, and the one the Drain waits for rather than refuses: this
 * Connection is already in the table when the flag flips, so it is ended like any other — the
 * ending is carried out after its `ready` (ADR-0004) — and the Transport is closed only once it
 * has left. Its pending `tail` is never cut by that close, which is the whole reason the wait is
 * on the table rather than on a timer.
 */
test("a Connection awaiting the log when the Drain starts is ended, not cut by the close", async () => {
  const { response, drained } = await drainMidOpen("tail");

  const frames = await opened(response);
  expect((await frames.next()).event).toBe("reconnect");
  await expect(frames.next()).rejects.toThrow(/stream ended/);
  await drained;
  expect(held()).toBe(0);
});

/**
 * The default posture of ADR-0011: the library listens for the signals an orchestrator ends a
 * process with, once per process, and Next.js's own listeners stay in place beside it — Node
 * runs every one of them, which is what makes the Drain and `server.close()` self-synchronizing.
 */
test("the signal handlers are installed by default, once per process", () => {
  getInstance({ transport: createMemoryTransport(), drain: 250 });
  expect(installed()).toEqual([1, 1]);

  getInstance({ transport: createMemoryTransport(), drain: 250 });
  expect(installed()).toEqual([1, 1]);
});

/** The signal is the whole of what the listener does: it Drains, and it never exits. */
test("the listener Drains the Instance, and leaves the exit to the process", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const instance = getInstance({ transport: createMemoryTransport(), drain: 0 });
  const [listener] = process.listeners("SIGTERM").slice(-1);

  (listener as () => void)();

  expect(instance.draining).toBe(true);
  expect(exit).not.toHaveBeenCalled();
  await instance.drain();
});

/** `false` is the App saying it sequences its own shutdown: nothing is installed (ADR-0011). */
test("drain: false installs no handler, and leaves sse.drain() usable", async () => {
  const sse = anApp({ drain: false });
  await connect(sse);

  expect(installed()).toEqual([0, 0]);

  await sse.drain();
  expect(held()).toBe(0);
});

/** The window is a duration like the other two, and refused the same way when it is not. */
test("a window that is not a duration is refused, and false is the one value that is not one", () => {
  expect(() => getInstance({ transport: createMemoryTransport(), drain: -1 })).toThrow(
    /milliseconds/,
  );
  expect(() => getInstance({ transport: createMemoryTransport(), drain: Number.NaN })).toThrow(
    /Pass false/,
  );
  expect(getInstance({ transport: createMemoryTransport(), drain: false })).toMatchObject({
    draining: false,
  });
});
