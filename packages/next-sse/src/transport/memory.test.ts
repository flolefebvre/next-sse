import { expect, test, vi } from "vitest";

import { createMemoryTransport } from "./memory.js";
import { type Entry, type StoredEntry } from "./index.js";

/**
 * What is this Transport's own: its epoch, and the retention numbers ADR-0006 gives it. The
 * obligation it shares with every other Transport is proven by `transportContract`, which the
 * integration project runs against this very factory.
 */

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

test("read answers gone for a Cursor another Memory log minted", async () => {
  const transport = createMemoryTransport();
  const other = createMemoryTransport();
  await transport.publish(message("chat:42", { text: "one" }));

  const foreign = await other.publish(message("chat:42", { text: "elsewhere" }));

  expect(await transport.read(foreign, 100)).toEqual({ gone: true });
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
