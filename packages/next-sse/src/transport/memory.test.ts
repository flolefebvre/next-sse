import { expect, test, vi } from "vitest";

import { createMemoryTransport } from "./memory.js";
import { TransportClosedError, type Entry, type StoredEntry } from "./index.js";

const message = (channel: string, payload: unknown): Entry => ({
  v: 1,
  type: "message",
  channel,
  event: "message",
  payload,
});

/** What the Messages of a page carry, which is what a test about ordering wants to compare. */
const payloadsOf = (entries: StoredEntry[]): unknown[] =>
  entries.filter((entry) => entry.type === "message").map((entry) => entry.payload);

/** The whole log, however many pages it takes, so a test never depends on the page size. */
const readAll = async (
  transport: ReturnType<typeof createMemoryTransport>,
  after?: string,
): Promise<StoredEntry[]> => {
  const page = await transport.read(after, 100);
  if ("gone" in page) throw new Error("the log answered gone");

  return page.entries;
};

test("publish returns the Cursor it minted, and the log hands that same Cursor back", async () => {
  const transport = createMemoryTransport();

  const first = await transport.publish(message("chat:42", { text: "one" }));
  const second = await transport.publish(message("chat:42", { text: "two" }));

  expect(first).not.toBe(second);
  expect((await readAll(transport)).map((entry) => entry.cursor)).toEqual([first, second]);
});

test("an Entry comes back out of the log as it was published, and is not the object published", async () => {
  const transport = createMemoryTransport();
  const entry = message("chat:42", { text: "one" });

  const cursor = await transport.publish(entry);
  entry.channel = "chat:other";

  const [stored] = await readAll(transport);
  expect(stored).toEqual({ ...message("chat:42", { text: "one" }), cursor });
});

test("tail answers a Cursor on an empty log, and that Cursor reads from the start", async () => {
  const transport = createMemoryTransport();

  const beforeAnything = await transport.tail();
  expect(typeof beforeAnything).toBe("string");
  expect(beforeAnything).not.toBe("");

  const cursor = await transport.publish(message("chat:42", { text: "one" }));
  expect(await readAll(transport, beforeAnything)).toHaveLength(1);
  expect(await transport.tail()).toBe(cursor);
});

test("read pages strictly after a Cursor and reports whether the caller has caught up", async () => {
  const transport = createMemoryTransport();
  const first = await transport.publish(message("chat:42", { text: "one" }));
  await transport.publish(message("chat:42", { text: "two" }));
  await transport.publish(message("chat:42", { text: "three" }));

  const page = await transport.read(first, 1);
  if ("gone" in page) throw new Error("the log answered gone");

  expect(payloadsOf(page.entries)).toEqual([{ text: "two" }]);
  expect(page.done).toBe(false);

  const rest = await transport.read(page.entries[0]?.cursor, 100);
  if ("gone" in rest) throw new Error("the log answered gone");

  expect(payloadsOf(rest.entries)).toEqual([{ text: "three" }]);
  expect(rest.done).toBe(true);
});

test("read from the tail of the log answers no Entries and done", async () => {
  const transport = createMemoryTransport();
  const cursor = await transport.publish(message("chat:42", { text: "one" }));

  expect(await transport.read(cursor, 100)).toEqual({ entries: [], done: true });
});

test("read without a Cursor answers the whole log", async () => {
  const transport = createMemoryTransport();
  await transport.publish(message("chat:42", { text: "one" }));
  await transport.publish(message("chat:42", { text: "two" }));

  expect(await readAll(transport)).toHaveLength(2);
});

test("read answers gone for a Cursor this log never minted", async () => {
  const transport = createMemoryTransport();
  const other = createMemoryTransport();
  await transport.publish(message("chat:42", { text: "one" }));

  const foreign = await other.publish(message("chat:42", { text: "elsewhere" }));

  expect(await transport.read(foreign, 100)).toEqual({ gone: true });
  expect(await transport.read("not-a-cursor", 100)).toEqual({ gone: true });
  expect(await transport.read("", 100)).toEqual({ gone: true });
});

test("subscribe delivers every later Entry, with its Cursor, including this Instance's own", async () => {
  const transport = createMemoryTransport();
  await transport.publish(message("chat:42", { text: "before" }));

  const received: StoredEntry[] = [];
  await transport.subscribe((entry) => received.push(entry), { onGap: () => undefined });

  const cursor = await transport.publish(message("chat:42", { text: "after" }));
  const kick = await transport.publish({ v: 1, type: "control", control: "kick", key: "user-7" });

  expect(received).toEqual([
    { ...message("chat:42", { text: "after" }), cursor },
    { v: 1, type: "control", control: "kick", key: "user-7", cursor: kick },
  ]);
});

test("several listeners attach to the one log, and unsubscribing detaches only its own", async () => {
  const transport = createMemoryTransport();
  const one = vi.fn();
  const two = vi.fn();

  const detach = await transport.subscribe(one, { onGap: () => undefined });
  await transport.subscribe(two, { onGap: () => undefined });

  await transport.publish(message("chat:42", { text: "one" }));
  detach();
  await transport.publish(message("chat:42", { text: "two" }));

  expect(one).toHaveBeenCalledTimes(1);
  expect(two).toHaveBeenCalledTimes(2);
});

test("a closed Transport answers nothing further, and closing twice is not an error", async () => {
  const transport = createMemoryTransport();
  const listener = vi.fn();
  await transport.subscribe(listener, { onGap: () => undefined });
  await transport.publish(message("chat:42", { text: "one" }));

  await transport.close();
  await transport.close();

  await expect(transport.publish(message("chat:42", { text: "two" }))).rejects.toThrow(
    TransportClosedError,
  );
  await expect(transport.tail()).rejects.toThrow(TransportClosedError);
  await expect(transport.read(undefined, 100)).rejects.toThrow(TransportClosedError);
  await expect(transport.subscribe(listener, { onGap: () => undefined })).rejects.toThrow(
    TransportClosedError,
  );
  expect(listener).toHaveBeenCalledTimes(1);
});

test("the cap bounds the log, and a Cursor into what it dropped is gone", async () => {
  const transport = createMemoryTransport({ retention: { cap: 2 } });
  const first = await transport.publish(message("chat:42", { text: "one" }));
  const second = await transport.publish(message("chat:42", { text: "two" }));
  await transport.publish(message("chat:42", { text: "three" }));
  await transport.publish(message("chat:42", { text: "four" }));

  expect(payloadsOf(await readAll(transport))).toEqual([{ text: "three" }, { text: "four" }]);
  expect(await transport.read(first, 100)).toEqual({ gone: true });
  expect(payloadsOf(await readAll(transport, second))).toEqual([
    { text: "three" },
    { text: "four" },
  ]);
});

/**
 * The Cursor of the newest dropped Entry is the exact boundary (ADR-0006): nothing published
 * after it was lost, so it still reads, while everything below it is gone. Trimming takes
 * Entries out of the log, never positions out of the sequence: what the log mints next carries
 * on from where it was, however little of it is left.
 */
test("the Cursor of the last dropped Entry still reads: gone is exact, not approximate", async () => {
  const transport = createMemoryTransport({ retention: { cap: 1 } });
  const first = await transport.publish(message("chat:42", { text: "one" }));
  const second = await transport.publish(message("chat:42", { text: "two" }));
  const third = await transport.publish(message("chat:42", { text: "three" }));

  expect(await transport.read(first, 100)).toEqual({ gone: true });
  expect(payloadsOf(await readAll(transport, second))).toEqual([{ text: "three" }]);
  expect(await transport.read(third, 100)).toEqual({ entries: [], done: true });
  expect(new Set([first, second, third]).size).toBe(3);
  expect(await transport.tail()).toBe(third);
});

test("the window drops what has aged out, and says so to a Cursor that pointed into it", async () => {
  vi.useFakeTimers();

  try {
    const transport = createMemoryTransport({ retention: { window: 300 } });
    const first = await transport.publish(message("chat:42", { text: "old" }));
    await transport.publish(message("chat:42", { text: "older still" }));

    vi.advanceTimersByTime(299_000);
    const recent = await transport.publish(message("chat:42", { text: "recent" }));

    vi.advanceTimersByTime(1000);

    expect(await transport.read(first, 100)).toEqual({ gone: true });
    expect(payloadsOf(await readAll(transport))).toEqual([{ text: "recent" }]);
    expect(payloadsOf(await readAll(transport, recent))).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

/**
 * Retention is enforced when the log is read, not only when it is written: a log nobody
 * Publishes into any more must not keep answering with Entries it promised to forget.
 */
test("a log that went quiet still ages out, and tail keeps answering", async () => {
  vi.useFakeTimers();

  try {
    const transport = createMemoryTransport({ retention: { window: 300 } });
    const cursor = await transport.publish(message("chat:42", { text: "one" }));

    vi.advanceTimersByTime(300_001);

    expect(await transport.read(undefined, 100)).toEqual({ entries: [], done: true });
    expect(await transport.read(cursor, 100)).toEqual({ entries: [], done: true });
    expect(await transport.tail()).toBe(cursor);
  } finally {
    vi.useRealTimers();
  }
});

test("retention defaults to the 300 s window and the 10 000 Entry cap of ADR-0006", async () => {
  vi.useFakeTimers();

  try {
    const transport = createMemoryTransport();
    const beforeAnything = await transport.tail();

    for (let n = 0; n < 10_000; n += 1) {
      await transport.publish(message("chat:42", { text: "one of ten thousand" }));
    }

    const full = await transport.read(beforeAnything, 20_000);
    if ("gone" in full) throw new Error("the log answered gone");
    expect(full.entries).toHaveLength(10_000);

    await transport.publish(message("chat:42", { text: "one too many" }));
    expect(await transport.read(beforeAnything, 20_000)).toEqual({ gone: true });

    const survivor = await transport.tail();
    vi.advanceTimersByTime(300_001);

    expect(await transport.read(survivor, 100)).toEqual({ entries: [], done: true });
    expect(await transport.read(undefined, 100)).toEqual({ entries: [], done: true });
  } finally {
    vi.useRealTimers();
  }
});
