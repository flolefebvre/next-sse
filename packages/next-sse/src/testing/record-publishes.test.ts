import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import { INSTANCE_SLOT } from "../internal/instance-slot.js";
import { initSSE } from "../server/index.js";
import { createMemoryTransport } from "../transport/memory.js";

import { recordPublishes, type PublishedMessage } from "./record-publishes.js";

/**
 * An App's Registry, built the way an App builds one: at module load, by the module a test
 * imports. The Instance is process-wide and a test file is a process of its own, so this file
 * has one Instance for all its tests — which is exactly the situation a consumer's suite is in,
 * and why isolation has to come from where each recorder starts rather than from a reset.
 */
const { channel, createSSE } = initSSE({
  transport: createMemoryTransport(),
  key: (ctx: { userId: string }) => ctx.userId,
});

const sse = createSSE({
  notes: channel({
    pattern: "notes:{listId}",
    events: {
      created: z.object({ id: z.string() }),
      /** A schema whose Output is not its Input: what the log stores is the Output. */
      renamed: z
        .object({ id: z.string(), title: z.string() })
        .transform(({ id, title }) => ({ id, title: title.trim().toUpperCase() })),
    },
    authorize: () => true,
  }),
});

test("with no Instance in the process, it says which module to import first", async () => {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  const instance = globals[INSTANCE_SLOT];
  delete globals[INSTANCE_SLOT];

  try {
    await expect(recordPublishes()).rejects.toThrow(/import the module that builds your Registry/i);
  } finally {
    globals[INSTANCE_SLOT] = instance;
  }
});

test("it reads, in order, the Messages published after it started", async () => {
  await sse.notes({ listId: "1" }).created({ id: "before" });

  const published = await recordPublishes();
  await sse.notes({ listId: "1" }).created({ id: "a" });
  await sse.notes({ listId: "2" }).created({ id: "b" });

  expect(await published()).toEqual([
    { channel: "notes:1", event: "created", payload: { id: "a" } },
    { channel: "notes:2", event: "created", payload: { id: "b" } },
  ]);
  expectTypeOf(await published()).toEqualTypeOf<PublishedMessage[]>();
});

test("a second test in the same file sees none of the first one's Messages", async () => {
  const published = await recordPublishes();
  await sse.notes({ listId: "1" }).created({ id: "c" });

  expect(await published()).toEqual([
    { channel: "notes:1", event: "created", payload: { id: "c" } },
  ]);
});

test("a Kick is not a Message, and is left out", async () => {
  const published = await recordPublishes();
  await sse.kick({ key: "ada" });
  await sse.kick(sse.notes({ listId: "1" }));
  await sse.notes({ listId: "1" }).created({ id: "d" });

  expect(await published()).toEqual([
    { channel: "notes:1", event: "created", payload: { id: "d" } },
  ]);
});

test("the payload is the schema's Output, as the log stores it", async () => {
  const published = await recordPublishes();
  await sse.notes({ listId: "1" }).renamed({ id: "e", title: "  groceries " });

  expect(await published()).toEqual([
    { channel: "notes:1", event: "renamed", payload: { id: "e", title: "GROCERIES" } },
  ]);
});

test("reading twice reads everything since the start, both times", async () => {
  const published = await recordPublishes();
  await sse.notes({ listId: "1" }).created({ id: "f" });
  const first = await published();
  await sse.notes({ listId: "1" }).created({ id: "g" });

  expect(first.map(({ payload }) => payload)).toEqual([{ id: "f" }]);
  expect((await published()).map(({ payload }) => payload)).toEqual([{ id: "f" }, { id: "g" }]);
});
