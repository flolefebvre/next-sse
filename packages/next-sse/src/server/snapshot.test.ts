import { beforeEach, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import { INSTANCE_SLOT } from "../internal/instance-slot.js";
import type { Snapshot } from "../client/index.js";
import { cursorOf } from "../internal/snapshot.js";
import { createMemoryTransport } from "../transport/memory.js";
import type { Cursor, Transport } from "../transport/index.js";

import { initSSE } from "./index.js";

/**
 * Every test declares its own App, and the Instance is a `globalThis` slot (ADR-0004): without
 * this, the second `initSSE` of the file would hand back the first one's Transport.
 */
beforeEach(() => {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  delete globals[INSTANCE_SLOT];
});

/** One App on a log the test can read for itself, which is how the ordering claim is checked. */
const anApp = () => {
  const transport = createMemoryTransport();
  const { channel, createSSE } = initSSE({ drain: false, transport });

  return {
    transport,
    sse: createSSE({
      chat: channel({
        pattern: "chat:{roomId}",
        events: { message: z.object({ text: z.string() }) },
        authorize: () => true,
      }),
    }),
  };
};

/** What the log holds after a Cursor, which for a Snapshot is what the client will be replayed. */
const after = async (transport: Transport, cursor: Cursor): Promise<Cursor[]> => {
  const page = await transport.read(cursor, 100);
  if ("gone" in page) throw new Error("the log dropped what this test just published");

  return page.entries.map((entry) => entry.cursor);
};

test("the Cursor is taken before the read runs, which is the whole ordering rule", async () => {
  const { sse, transport } = anApp();
  const chat = sse.chat({ roomId: "42" });

  const published: Cursor[] = [];
  const snapshot = await sse.snapshot(async () => {
    published.push(await chat.message({ text: "published while the read ran" }));

    return ["read after the Publish"];
  });

  /**
   * A Message the read did not see is after the Snapshot's Cursor, so the Instance replays it
   * and the client sees it exactly once. Taking the Cursor after the read would have lost it,
   * and no App code is in a position to make that mistake.
   */
  expect(await after(transport, cursorOf(snapshot))).toEqual(published);
  expect(snapshot.data).toEqual(["read after the Publish"]);
});

test("the Cursor a Snapshot carries is the log's tail when it was taken", async () => {
  const { sse, transport } = anApp();
  await sse.chat({ roomId: "42" }).message({ text: "before the read" });

  const tail = await transport.tail();
  const snapshot = await sse.snapshot(() => "data");

  expect(cursorOf(snapshot)).toBe(tail);
  expect(await sse.cursor()).toBe(tail);
});

test("a Snapshot is plain data: it crosses the RSC boundary as a prop", async () => {
  const { sse } = anApp();

  const snapshot = await sse.snapshot(() => ({ messages: [{ id: "1", text: "hello" }] }));

  expect(JSON.parse(JSON.stringify(snapshot))).toEqual({
    data: { messages: [{ id: "1", text: "hello" }] },
    cursor: expect.any(String),
  });
});

test("the read may be synchronous, and the data alone types the Snapshot", async () => {
  const { sse } = anApp();

  const snapshot = await sse.snapshot(() => [1, 2, 3]);

  expectTypeOf(snapshot).toEqualTypeOf<Snapshot<number[]>>();
  expectTypeOf(snapshot.data).toEqualTypeOf<number[]>();
  expect(snapshot.data).toEqual([1, 2, 3]);

  const reading = () => {
    // @ts-expect-error the Cursor is not a property a reader has: only the library sees it
    void snapshot.cursor;
  };
  expect(reading).toBeTypeOf("function");
});

test("a Channel called cursor is refused, the way every Registry key is", () => {
  const { channel, createSSE } = initSSE({ drain: false, transport: createMemoryTransport() });
  const declaring = () =>
    createSSE({
      // @ts-expect-error the Registry needs `cursor` for the handoff of ADR-0007
      cursor: channel({ pattern: "cursor", events: { tick: z.object({}) } }),
    });

  expect(declaring).toThrow(/Channel called "cursor"/);
});
