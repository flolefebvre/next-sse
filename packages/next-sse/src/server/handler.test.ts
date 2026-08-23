import { getEventListeners } from "node:events";

import { beforeEach, expect, test } from "vitest";

import type { Cursor } from "../transport/index.js";
import { createMemoryTransport } from "../transport/memory.js";

import { initSSE } from "./index.js";
import { getInstance } from "./instance.js";

beforeEach(() => {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  delete globals[Symbol.for("@flefebvre/next-sse")];
});

/** One SSE block, as a client parses it: the fields it carried, by name. */
interface Frame {
  id?: string;
  event?: string;
  data?: string;
  retry?: string;
}

/**
 * The App of these tests: one Channel with one declared event. The Registry is loosely typed
 * until the typing ticket infers it, so the tests name the shape they expect of it — which is
 * the runtime shape the final types will describe.
 */
interface ChatHandle {
  publish(event: string, payload: unknown): Promise<Cursor>;
  message(payload: unknown): Promise<Cursor>;
}

interface ChatApp {
  handlers: { GET: (request: Request) => Promise<Response> };
  chat(params?: Record<string, string>): ChatHandle;
}

const appWith = (transport = createMemoryTransport()): ChatApp => {
  const { channel, createSSE } = initSSE({ transport });

  return createSSE({
    chat: channel({ pattern: "chat:{roomId}", events: { message: undefined } }),
  }) as unknown as ChatApp;
};

const connect = async (sse: ChatApp, query: string, signal?: AbortSignal): Promise<Response> =>
  sse.handlers.GET(
    new Request(`http://example.test/api/sse${query}`, signal ? { signal } : undefined),
  );

/**
 * A Connection past its opening sequence, which is where every test about the live feed starts.
 */
const liveConnection = async (sse: ChatApp, query: string): Promise<Frames> => {
  const frames = framesOf(await connect(sse, query));
  await frames.next();
  await frames.next();
  await frames.next();

  return frames;
};

/** Reads SSE blocks off a response body, one at a time, in the order they were written. */
interface Frames {
  next: () => Promise<Frame>;
  cancel: () => Promise<void>;
}

function framesOf(response: Response): Frames {
  const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  return {
    async next(): Promise<Frame> {
      for (;;) {
        const end = buffered.indexOf("\n\n");
        if (end !== -1) {
          const block = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);

          return parse(block);
        }

        const { done, value } = await reader.read();
        if (done) throw new Error("the stream ended before the next block");
        buffered += decoder.decode(value);
      }
    },
    cancel: () => reader.cancel(),
  };
}

function parse(block: string): Frame {
  const frame: Frame = {};
  for (const line of block.split("\n")) {
    const [name, value] = [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)];
    if (name === "id" || name === "event" || name === "data" || name === "retry") {
      frame[name] = value;
    }
  }

  return frame;
}

test("a Connection that names no Channel is refused before anything is opened", async () => {
  const sse = appWith();

  const response = await connect(sse, "");

  expect(response.status).toBe(400);
  expect(getInstance().connections.size).toBe(0);
});

test("the stream carries exactly the headers of ADR-0004", async () => {
  const sse = appWith();

  const response = await connect(sse, "?channel=chat:42");

  expect(response.status).toBe(200);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => (headers[name] = value));

  expect(headers).toEqual({
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  });
  await framesOf(response).cancel();
});

test("the stream opens on ready, then retry, then caught-up", async () => {
  const transport = createMemoryTransport();
  const sse = appWith(transport);
  const tail = await transport.tail();

  const frames = framesOf(await connect(sse, "?channel=chat:42"));

  expect(await frames.next()).toEqual({
    event: "ready",
    data: JSON.stringify({ cursor: tail, refused: [] }),
  });
  expect(await frames.next()).toEqual({ retry: "3000" });
  expect(await frames.next()).toEqual({ event: "caught-up", data: "{}" });
  await frames.cancel();
});

test("a Message Published after connect arrives on its event name, with its Cursor as the id", async () => {
  const transport = createMemoryTransport();
  const sse = appWith(transport);
  const frames = await liveConnection(sse, "?channel=chat:42");

  const cursor = await sse.chat({ roomId: "42" }).message({ text: "hello" });

  expect(await frames.next()).toEqual({
    id: cursor,
    event: "message",
    data: JSON.stringify({ text: "hello" }),
  });
  await frames.cancel();
});

test("a Connection is fed only the Channels it named", async () => {
  const transport = createMemoryTransport();
  const sse = appWith(transport);
  const frames = await liveConnection(sse, "?channel=chat:42");

  await sse.chat({ roomId: "7" }).message({ text: "elsewhere" });
  const cursor = await sse.chat({ roomId: "42" }).message({ text: "here" });

  expect((await frames.next()).id).toBe(cursor);
  await frames.cancel();
});

test("a Connection may name several Channels", async () => {
  const transport = createMemoryTransport();
  const sse = appWith(transport);
  const frames = await liveConnection(sse, "?channel=chat:42&channel=chat:7");

  await sse.chat({ roomId: "7" }).message({ text: "seven" });

  expect((await frames.next()).data).toBe(JSON.stringify({ text: "seven" }));
  await frames.cancel();
});

test("a client that goes away leaves no Connection behind and no listener on the request", async () => {
  const sse = appWith();
  const client = new AbortController();
  const response = await connect(sse, "?channel=chat:42", client.signal);
  const frames = framesOf(response);
  await frames.next();

  expect(getInstance().connections.size).toBe(1);
  client.abort();

  expect(getInstance().connections.size).toBe(0);
  expect(getEventListeners(client.signal, "abort")).toHaveLength(0);
});

test("a cancelled stream leaves no Connection behind either", async () => {
  const sse = appWith();
  const frames = framesOf(await connect(sse, "?channel=chat:42"));
  await frames.next();

  await frames.cancel();

  expect(getInstance().connections.size).toBe(0);
});

test("a Handle publishes on the declared event name, and on a dynamic one", async () => {
  const transport = createMemoryTransport();
  const sse = appWith(transport);

  await sse.chat({ roomId: "42" }).message({ text: "declared" });
  await sse.chat({ roomId: "42" }).publish("typing", { who: "ada" });

  const page = await transport.read(undefined, 100);
  if ("gone" in page) throw new Error("the log answered gone");

  const published = page.entries
    .filter((entry) => entry.type === "message")
    .map((entry) => `${entry.channel}/${entry.event}`);

  expect(published).toEqual(["chat:42/message", "chat:42/typing"]);
});

test("a Handle missing a param of its pattern is an error, not a Channel with a brace in it", () => {
  const sse = appWith();

  expect(() => sse.chat()).toThrow(/roomId/);
});

test("a re-evaluated Registry publishes into the log the open Connections are reading", async () => {
  const sse = appWith();
  const frames = await liveConnection(sse, "?channel=chat:42");

  const reevaluated = appWith(createMemoryTransport());
  const cursor = await reevaluated.chat({ roomId: "42" }).message({ text: "after the edit" });

  expect(await frames.next()).toEqual({
    id: cursor,
    event: "message",
    data: JSON.stringify({ text: "after the edit" }),
  });
  await frames.cancel();
});
