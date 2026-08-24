import { beforeEach, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import type { Snapshot } from "../client/index.js";
import { cursorOf } from "../internal/snapshot.js";
import { initSSE } from "../server/index.js";
import { createMemoryTransport } from "../transport/memory.js";

import { snapshotOf } from "./snapshot.js";

/**
 * What a consumer's component test mints, held to the one thing that matters about it: it must
 * be the value a Server Component would have handed down, not a lookalike. A test Snapshot that
 * the hooks read differently from a real one would make every consumer's suite agree with
 * itself and disagree with production.
 */
/** The Instance is a `globalThis` slot (ADR-0004): a leftover one would serve the App below. */
beforeEach(() => {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  delete globals[Symbol.for("@flefebvre/next-sse")];
});

test("a test Snapshot carries the data it was given, at the Cursor it was given", () => {
  const snapshot = snapshotOf([{ id: "1", text: "one" }], "cursor-7");

  expect(snapshot.data).toEqual([{ id: "1", text: "one" }]);
  expect(cursorOf(snapshot)).toBe("cursor-7");
  expectTypeOf(snapshot).toEqualTypeOf<Snapshot<{ id: string; text: string }[]>>();
});

test("it is sealed exactly as the App's own handoff seals one", async () => {
  const transport = createMemoryTransport();
  const { channel, createSSE } = initSSE({ drain: false, transport });
  const sse = createSSE({
    chat: channel({
      pattern: "chat:{roomId}",
      events: { message: z.object({ text: z.string() }) },
      authorize: () => true,
    }),
  });

  const real = await sse.snapshot(() => ["what the server read"]);
  const forTest = snapshotOf(["what the server read"], cursorOf(real));

  expect(forTest).toEqual(real);
});
