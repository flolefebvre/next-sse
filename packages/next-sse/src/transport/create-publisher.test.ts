import { expect, expectTypeOf, test } from "vitest";

import type { ChannelDeclaration } from "../internal/channel.js";
import type { StandardSchemaV1 } from "../internal/standard-schema.js";

import {
  createPublisher,
  type ChannelNameOf,
  type ChannelNames,
  type Cursor,
  type Entry,
  type Publisher,
} from "./index.js";
import { createMemoryTransport } from "./memory.js";

/**
 * One App, named the only way a worker may name one: as a type. It carries a schema whose Input
 * and Output differ, because that difference is the point of the payload type — a worker writes
 * what the wire carries, not what the App's server code would have written.
 */
type Chat = ChannelDeclaration<
  "chat:{roomId}",
  { message: StandardSchemaV1<{ text: string }, { id: string; text: string }> }
>;
type Announcements = ChannelDeclaration<
  "announcements",
  { posted: StandardSchemaV1<{ title: string }> }
>;
type Report = ChannelDeclaration<
  "report:{year}:{month}",
  { ready: StandardSchemaV1<{ url: string }> }
>;

type App = { channels: { chat: Chat; announcements: Announcements; report: Report } };

/** A Publisher that keeps what it was handed: what the worker writes is the whole assertion. */
function recordingPublisher(): { publisher: Publisher; written: Entry[] } {
  const written: Entry[] = [];

  return {
    written,
    publisher: {
      publish: async (entry) => {
        written.push(entry);

        return `cursor-${String(written.length)}`;
      },
      tail: async () => "cursor-0",
      close: async () => undefined,
    },
  };
}

test("a pattern's Channel names are its literal text with every param left open", () => {
  expectTypeOf<ChannelNameOf<"chat:{roomId}">>().toEqualTypeOf<`chat:${string}`>();
  expectTypeOf<ChannelNameOf<"announcements">>().toEqualTypeOf<"announcements">();
  expectTypeOf<
    ChannelNameOf<"report:{year}:{month}">
  >().toEqualTypeOf<`report:${string}:${string}`>();
});

test("an App's Channel names are what its patterns can make, and nothing else", () => {
  expectTypeOf<ChannelNames<App>>().toEqualTypeOf<
    `chat:${string}` | "announcements" | `report:${string}:${string}`
  >();
});

test("a worker publishes the Message envelope of ADR-0006 and gets the Cursor back", async () => {
  const { publisher, written } = recordingPublisher();
  const sse = createPublisher<App>(publisher);

  const cursor = await sse.publish("chat:42", "message", { id: "1", text: "one" });

  expect(cursor).toBe("cursor-1");
  expect(written).toEqual([
    {
      v: 1,
      type: "message",
      channel: "chat:42",
      event: "message",
      payload: { id: "1", text: "one" },
    },
  ]);
});

test("what a worker publishes is readable off the log as any other Entry", async () => {
  const transport = createMemoryTransport();
  const sse = createPublisher<App>(transport);

  await sse.publish("announcements", "posted", { title: "we shipped" });
  const page = await transport.read(undefined, 10);

  expect(page).toMatchObject({
    entries: [{ type: "message", channel: "announcements", event: "posted" }],
  });
  await transport.close();
});

test("the payload is the schema's Output, and the Cursor is what the Publisher minted", () => {
  const { publisher } = recordingPublisher();
  const sse = createPublisher<App>(publisher);

  expectTypeOf(sse.publish("chat:1", "message", { id: "1", text: "one" })).toEqualTypeOf<
    Promise<Cursor>
  >();
  expectTypeOf<Parameters<typeof sse.publish<`chat:${string}`, "message">>[2]>().toEqualTypeOf<{
    id: string;
    text: string;
  }>();
});

test("a Channel no pattern can make, an undeclared event and a wrong payload are all refused", () => {
  const { publisher } = recordingPublisher();
  const sse = createPublisher<App>(publisher);

  /** A Channel name outside every pattern this App declares. */
  // @ts-expect-error "presence:1" is not a name any of this App's patterns can make
  void sse.publish("presence:1", "message", { id: "1", text: "one" });
  /** The literal pattern names exactly one Channel, so a param on it is not one. */
  // @ts-expect-error "announcements:42" is not the Channel "announcements"
  void sse.publish("announcements:42", "posted", { title: "we shipped" });
  /** An event the Channel this name belongs to does not carry. */
  // @ts-expect-error the chat Channel carries no "joined" event
  void sse.publish("chat:42", "joined", { who: "ada" });
  /** The Output of the event's schema, and not its Input. */
  // @ts-expect-error the wire carries the Output, which has an id
  void sse.publish("chat:42", "message", { text: "one" });
});

/**
 * Two patterns with params that one name satisfies at once. `createSSE` refuses an App declaring
 * these (#68), and this path is where that refusal cannot reach: a worker holds the App as a
 * type and never runs its `createSSE`, and the type-level match is coarser than the matcher's
 * anyway. So the obligation is kept here too — `user:7` is a name of both Channels, and one
 * Entry on it is read by the subscribers of both.
 */
type Overlapping = {
  channels: {
    user: ChannelDeclaration<"user:{id}", { ping: StandardSchemaV1<{ a: string }> }>;
    kind: ChannelDeclaration<"{kind}:7", { ping: StandardSchemaV1<{ b: number }> }>;
    only: ChannelDeclaration<"only:{id}", { ping: StandardSchemaV1<{ c: boolean }> }>;
  };
};

test("a name two patterns both match owes a payload both declarations accept", () => {
  const { publisher } = recordingPublisher();
  const sse = createPublisher<Overlapping>(publisher);

  expectTypeOf<Parameters<typeof sse.publish<"user:7", "ping">>[2]>().toEqualTypeOf<
    { a: string } & { b: number }
  >();

  void sse.publish("user:7", "ping", { a: "x", b: 1 });
  /** Valid for `user:{id}` alone, and a lie to every subscriber of `{kind}:7`. */
  // @ts-expect-error the name also belongs to {kind}:7, whose ping carries a number b
  void sse.publish("user:7", "ping", { a: "x" });
});

test("a name only one pattern matches owes that declaration and nothing more", () => {
  const { publisher } = recordingPublisher();
  const sse = createPublisher<Overlapping>(publisher);

  expectTypeOf<Parameters<typeof sse.publish<"user:8", "ping">>[2]>().toEqualTypeOf<{
    a: string;
  }>();
  expectTypeOf<Parameters<typeof sse.publish<"only:9", "ping">>[2]>().toEqualTypeOf<{
    c: boolean;
  }>();

  void sse.publish("user:8", "ping", { a: "x" });
  void sse.publish("only:9", "ping", { c: true });
});

/** One Channel whose event carries a discriminated union, which is a payload and not a choice. */
type Shape = { kind: "circle"; r: number } | { kind: "square"; side: number };
type WithUnion = {
  channels: {
    shapes: ChannelDeclaration<"shapes:{id}", { drawn: StandardSchemaV1<Shape> }>;
  };
};

test("a schema whose Output is a union stays a union", () => {
  const { publisher } = recordingPublisher();
  const sse = createPublisher<WithUnion>(publisher);

  expectTypeOf<Parameters<typeof sse.publish<"shapes:1", "drawn">>[2]>().toEqualTypeOf<Shape>();

  void sse.publish("shapes:1", "drawn", { kind: "circle", r: 1 });
  void sse.publish("shapes:1", "drawn", { kind: "square", side: 2 });
});
