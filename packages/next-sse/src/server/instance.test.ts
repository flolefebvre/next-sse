import { beforeEach, expect, test, vi } from "vitest";

import { createMemoryTransport } from "../transport/memory.js";
import type { Entry } from "../transport/index.js";

import { getInstance, type Connection } from "./instance.js";
import type { StoredMessage } from "./wire.js";

/**
 * The Instance is a process-wide slot on purpose, so each test starts by emptying the slot the
 * way a fresh process would find it. Reaching for the symbol here is not a shortcut around the
 * module: the slot is the seam ADR-0004 specifies, and this is what asserts it is really used.
 */
beforeEach(() => {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  delete globals[Symbol.for("@flefebvre/next-sse")];
});

const message = (channel: string, payload: unknown): Entry => ({
  v: 1,
  type: "message",
  channel,
  event: "message",
  payload,
});

const connectionOn = (...channels: string[]): Connection => ({
  channels: new Set(channels),
  deliver: vi.fn<(entry: StoredMessage) => void>(),
});

test("the Instance keeps its Transport across evaluations, whatever a later one brings", () => {
  const first = createMemoryTransport();
  const second = createMemoryTransport();

  const instance = getInstance({ transport: first });

  expect(getInstance({ transport: second }).transport).toBe(first);
  expect(getInstance()).toBe(instance);
});

test("the Instance keeps its Connections across evaluations, and swaps the Registry", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  instance.registry = "the first Registry";
  const connection = connectionOn("chat:42");
  await instance.open(connection);

  const reevaluated = getInstance({ transport: createMemoryTransport() });
  reevaluated.registry = "the second Registry";

  expect(reevaluated.connections.has(connection)).toBe(true);
  expect(instance.registry).toBe("the second Registry");
});

test("a Message reaches the Connections subscribed to its Channel, and no others", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const subscribed = connectionOn("chat:42", "chat:7");
  const elsewhere = connectionOn("chat:7");
  await instance.open(subscribed);
  await instance.open(elsewhere);

  const cursor = await instance.transport.publish(message("chat:42", { text: "hello" }));

  expect(subscribed.deliver).toHaveBeenCalledWith({
    ...message("chat:42", { text: "hello" }),
    cursor,
  });
  expect(elsewhere.deliver).not.toHaveBeenCalled();
});

test("a Publish this Instance made itself comes back through the log like any other", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const connection = connectionOn("chat:42");
  await instance.open(connection);

  await instance.transport.publish(message("chat:42", { text: "one" }));
  await instance.transport.publish(message("chat:42", { text: "two" }));

  expect(connection.deliver).toHaveBeenCalledTimes(2);
});

test("an Entry for a Channel nobody here holds, and a control Entry, reach no Connection", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const connection = connectionOn("chat:42");
  await instance.open(connection);

  await instance.transport.publish(message("chat:other", { text: "hello" }));
  await instance.transport.publish({ v: 1, type: "control", control: "kick", channel: "chat:42" });

  expect(connection.deliver).not.toHaveBeenCalled();
});

test("a Connection that was closed leaves the table and is fed nothing further", async () => {
  const instance = getInstance({ transport: createMemoryTransport() });
  const connection = connectionOn("chat:42");
  const close = await instance.open(connection);

  close();
  await instance.transport.publish(message("chat:42", { text: "hello" }));

  expect(instance.connections.size).toBe(0);
  expect(connection.deliver).not.toHaveBeenCalled();
});

test("the Instance reads the log once, however many Connections it holds", async () => {
  const transport = createMemoryTransport();
  const subscribe = vi.spyOn(transport, "subscribe");
  const instance = getInstance({ transport });

  await instance.open(connectionOn("chat:42"));
  await instance.open(connectionOn("chat:7"));

  expect(subscribe).toHaveBeenCalledTimes(1);
});
