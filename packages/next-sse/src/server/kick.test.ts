import { beforeEach, expect, expectTypeOf, test, vi } from "vitest";

import { INSTANCE_SLOT } from "../internal/instance-slot.js";
import type { Entry, Transport } from "../transport/index.js";
import { createMemoryTransport } from "../transport/memory.js";

import { asType, initSSE } from "./index.js";

/** The Instance is a `globalThis` slot (ADR-0004): every test here declares its own App. */
beforeEach(() => {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  delete globals[INSTANCE_SLOT];
});

/**
 * One App with a Key, and one Channel whose events include a name that would be a trap: `key`
 * becomes a method on the Handle, and a Kick must still read that Handle as a Channel.
 */
const anApp = (transport: Transport, key: ((ctx: never) => string | undefined) | undefined) => {
  const { channel, createSSE } = initSSE({ drain: false, transport, key });

  return createSSE({
    chat: channel({
      pattern: "chat:{roomId}",
      events: { message: asType<{ text: string }>(), key: asType<{ id: string }>() },
      authorize: () => true,
    }),
  });
};

const withAKey = (transport: Transport) => anApp(transport, () => "ada");
const withNoKey = (transport: Transport) => anApp(transport, undefined);

/** Everything this App wrote to its log from here on, read back as the Entries it published. */
const written = (transport: Transport): (() => Entry[]) => {
  const publish = vi.spyOn(transport, "publish");

  return () => publish.mock.calls.map(([entry]) => entry);
};

test("a Kick by Key writes exactly one control Entry, naming that Key", async () => {
  const transport = createMemoryTransport();
  const sse = withAKey(transport);
  const entries = written(transport);

  await expect(sse.kick({ key: "ada" })).resolves.toBeUndefined();

  expect(entries()).toEqual([{ v: 1, type: "control", control: "kick", key: "ada" }]);
});

/**
 * A Handle is bound to the Channel string its pattern and params make, and that string is what a
 * Connection's Channel set holds — so a Kick of a Handle is a match on the very same value.
 */
test("a Kick of a Handle names the Channel that Handle resolved to", async () => {
  const transport = createMemoryTransport();
  const sse = withAKey(transport);
  const entries = written(transport);

  await sse.kick(sse.chat({ roomId: "42" }));

  expect(entries()).toEqual([{ v: 1, type: "control", control: "kick", channel: "chat:42" }]);
});

/**
 * The two targets are told apart by `name`, which is a reserved event name and therefore always
 * the Channel string — not by `key`, which an App is free to declare an event called.
 */
test("a Handle carrying an event called key is still Kicked as a Channel", async () => {
  const transport = createMemoryTransport();
  const sse = withAKey(transport);
  const handle = sse.chat({ roomId: "42" });
  const entries = written(transport);

  expect(typeof handle.key).toBe("function");
  await sse.kick(handle);

  expect(entries()).toEqual([{ v: 1, type: "control", control: "kick", channel: "chat:42" }]);
});

test("a Handle carries the Channel it resolved to, not the Registry key it was declared under", () => {
  const sse = withAKey(createMemoryTransport());

  expect(sse.chat({ roomId: "42" }).name).toBe("chat:42");
  expectTypeOf(sse.chat({ roomId: "42" }).name).toEqualTypeOf<string>();
});

/**
 * An App that configured no `key` has no Connection carrying one, so this Kick could only ever
 * match nothing. That is the one outcome ADR-0003 rules out, and nothing is written for it.
 */
test("Kicking by Key with no key configured throws rather than writing a Kick that matches nothing", async () => {
  const transport = createMemoryTransport();
  const sse = withNoKey(transport);
  const entries = written(transport);

  await expect(sse.kick({ key: "ada" })).rejects.toThrow(/configured no `key`/);

  expect(entries()).toEqual([]);
});

/** An empty Key is the same failure by another route: a Kick that can name no Connection. */
test("Kicking by an empty Key throws", async () => {
  const sse = withAKey(createMemoryTransport());

  await expect(sse.kick({ key: "" })).rejects.toThrow(/takes the Key of the Connections to end/);
});

/**
 * `await kick()` resolves when the Entry is written and not when the Connections close: the
 * Instances that close them are on the far side of the log, with no reply channel back
 * (ADR-0003). What it does wait for is the write itself.
 */
test("a Kick resolves when the Entry is written, and not before", async () => {
  const memory = createMemoryTransport();
  let write: (() => void) | undefined;
  const transport: Transport = {
    ...memory,
    publish: async (entry) => {
      await new Promise<void>((resolve) => {
        write = resolve;
      });

      return memory.publish(entry);
    },
  };
  const sse = withAKey(transport);
  const settled = vi.fn();

  const kicked = sse.kick({ key: "ada" }).then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();

  write?.();
  await kicked;

  expect(settled).toHaveBeenCalledOnce();
});
