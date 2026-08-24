import { type } from "arktype";
import * as v from "valibot";
import { beforeEach, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import { createMemoryTransport } from "../transport/memory.js";
import type { Cursor } from "../transport/index.js";

import { asType, initSSE, InvalidPayloadError } from "./index.js";
import type { EventsOf, Handle, PatternOf } from "./index.js";

/**
 * Every test declares its own App, and the Instance is a `globalThis` slot (ADR-0004): without
 * this, the second `initSSE` of the file would hand back the first one's Transport.
 */
beforeEach(() => {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  delete globals[Symbol.for("@flefebvre/next-sse")];
});

const messageSchema = z.object({ text: z.string().trim() });
const typingSchema = v.object({ who: v.string() });

/** One App, declared the way an App declares one: the fixture every type claim below reads. */
const anApp = () => {
  const { channel, createSSE } = initSSE({ transport: createMemoryTransport() });

  return createSSE({
    chat: channel({
      pattern: "chat:{roomId}",
      events: { message: messageSchema, typing: typingSchema },
      authorize: () => true,
    }),
    announcements: channel({
      pattern: "announcements",
      events: { announcement: type({ title: "string" }) },
      authorize: () => true,
    }),
    inbox: channel({
      pattern: "user:{userId}:inbox",
      events: { mail: asType<{ id: string; unread?: boolean }>() },
      authorize: () => true,
    }),
  });
};

test("a Channel is called with the params its pattern names, and with none when it has none", () => {
  const sse = anApp();

  expectTypeOf(sse.chat).parameters.toEqualTypeOf<[params: { roomId: string }]>();
  expectTypeOf(sse.inbox).parameters.toEqualTypeOf<[params: { userId: string }]>();
  expectTypeOf(sse.announcements).parameters.toEqualTypeOf<[]>();

  /** Refused by the compiler, and never run: calling these would throw for real. */
  const refused = () => {
    // @ts-expect-error a Channel with params cannot be called without them
    sse.chat();
    // @ts-expect-error the pattern names roomId, not room
    sse.chat({ room: "42" });
    // @ts-expect-error a Channel with no params takes none
    sse.announcements({ roomId: "42" });
  };
  expect(refused).toBeTypeOf("function");
});

test("a Handle carries one method per declared event, and publish for a dynamic name", () => {
  const sse = anApp();
  const chat = sse.chat({ roomId: "42" });

  expectTypeOf(chat.message).toEqualTypeOf<(payload: { text: string }) => Promise<Cursor>>();
  expectTypeOf(chat.typing).toEqualTypeOf<(payload: { who: string }) => Promise<Cursor>>();
  expectTypeOf(chat.publish("message", { text: "hi" })).resolves.toBeString();

  /** Refused by the compiler, and never run: the runtime refuses them too, loudly. */
  const refused = () => {
    // @ts-expect-error the Channel carries no such event
    void chat.shout({ text: "hi" });
    // @ts-expect-error the Channel carries no such event, dynamic name or not
    void chat.publish("shout", { text: "hi" });
    // @ts-expect-error the payload is the message schema's Input
    void chat.message({ text: 42 });
    // @ts-expect-error the payload of a dynamic publish is checked against its event
    void chat.publish("typing", { text: "hi" });
  };
  expect(refused).toBeTypeOf("function");
});

/** zod 4, valibot and arktype are accepted as they are, and none of them is a dependency. */
test("a payload is typed by whichever Standard Schema declared it", () => {
  const sse = anApp();

  expectTypeOf(sse.chat({ roomId: "1" }).message)
    .parameter(0)
    .toEqualTypeOf<{ text: string }>();
  expectTypeOf(sse.chat({ roomId: "1" }).typing)
    .parameter(0)
    .toEqualTypeOf<{ who: string }>();
  expectTypeOf(sse.announcements().announcement).parameter(0).toEqualTypeOf<{ title: string }>();
  expectTypeOf(sse.inbox({ userId: "7" }).mail)
    .parameter(0)
    .toEqualTypeOf<{ id: string; unread?: boolean }>();
});

/**
 * The Registry is what everything downstream reads — the client, and the typed publisher of a
 * worker outside Next.js — so what `channel()` gives back is the declaration and nothing else:
 * no residue of the guards that checked it.
 */
test("what a Channel declares is what the Registry carries", () => {
  const sse = anApp();

  expectTypeOf<PatternOf<(typeof sse.channels)["chat"]>>().toEqualTypeOf<"chat:{roomId}">();
  expectTypeOf(sse.channels.chat.events.message).toEqualTypeOf(messageSchema);
  expectTypeOf(sse.channels.chat.events.typing).toEqualTypeOf(typingSchema);
  expectTypeOf(sse.channels.announcements.events).toHaveProperty("announcement");
});

test("an event whose schema produces what JSON cannot carry is refused", () => {
  const { channel } = initSSE({ transport: createMemoryTransport() });

  channel({ pattern: "audit", events: { at: z.iso.datetime() }, authorize: () => true });

  channel({
    pattern: "audit",
    // @ts-expect-error a Date does not survive the wire: z.iso.datetime() is the fix
    events: { at: z.date() },
    authorize: () => true,
  });
  channel({
    pattern: "audit",
    // @ts-expect-error a Map does not survive the wire either
    events: { seen: z.map(z.string(), z.string()) },
    authorize: () => true,
  });
});

test("an event named after something a Handle already has is refused", () => {
  const { channel } = initSSE({ transport: createMemoryTransport() });

  expect(() =>
    channel({
      pattern: "chat:{roomId}",
      // @ts-expect-error "publish" is a reserved event name
      events: { publish: asType<{ text: string }>() },
      authorize: () => true,
    }),
  ).toThrow(/"publish".*is reserved/);

  expect(() =>
    channel({
      pattern: "chat:{roomId}",
      // @ts-expect-error "name" is a reserved event name
      events: { name: asType<{ text: string }>() },
      authorize: () => true,
    }),
  ).toThrow(/"name".*is reserved/);
});

test("a Channel named after one of the Registry's own keys is refused", () => {
  const { channel, createSSE } = initSSE({ transport: createMemoryTransport() });
  const declaration = channel({
    pattern: "x:{id}",
    events: { ping: asType<null>() },
    authorize: () => true,
  });

  expect(() =>
    // @ts-expect-error "handlers" is a reserved Registry key
    createSSE({ handlers: declaration }),
  ).toThrow(/"handlers".*is reserved/);

  expect(() =>
    // @ts-expect-error "drain" is a reserved Registry key
    createSSE({ drain: declaration }),
  ).toThrow(/"drain".*is reserved/);
});

/** One Channel and the log under it, for the two tests that watch what a Publish writes. */
const aChatApp = () => {
  const transport = createMemoryTransport();
  const { channel, createSSE } = initSSE({ transport });
  const sse = createSSE({
    chat: channel({
      pattern: "chat:{roomId}",
      events: { message: messageSchema },
      authorize: () => true,
    }),
  });

  return { transport, sse };
};

test("a Publish validates its payload and puts what the schema produced on the wire", async () => {
  const { transport, sse } = aChatApp();

  await sse.chat({ roomId: "42" }).message({ text: "  hi  " });

  const page = await transport.read(undefined, 10);
  if ("gone" in page) throw new Error("the log answered gone");
  expect(page.entries.map((entry) => entry.type === "message" && entry.payload)).toEqual([
    { text: "hi" },
  ]);
});

test("a payload the schema refuses rejects the Publish, and reaches no log", async () => {
  const { transport, sse } = aChatApp();

  await expect(
    // @ts-expect-error the compiler says so too, and the runtime is what an untyped caller hits
    sse.chat({ roomId: "42" }).message({ text: 42 }),
  ).rejects.toBeInstanceOf(InvalidPayloadError);

  const page = await transport.read(undefined, 10);
  if ("gone" in page) throw new Error("the log answered gone");
  expect(page.entries).toEqual([]);
});

test("a Channel whose pattern has a placeholder the filler cannot fill is refused", () => {
  const { channel } = initSSE({ transport: createMemoryTransport() });

  expect(() => channel({ pattern: "chat:{room-id}", events: {}, authorize: () => true })).toThrow(
    /placeholder/,
  );
});

/** A `:` in a param value would forge a Channel name another pattern could have made. */
test("a param value that would forge another Channel name is refused", () => {
  const sse = anApp();

  expect(() => sse.chat({ roomId: "42:secret" })).toThrow(/must not contain/);
});

test("a Handle is the Handle of its Channel's events", () => {
  const sse = anApp();

  expectTypeOf(sse.chat({ roomId: "1" })).toExtend<
    Handle<EventsOf<(typeof sse.channels)["chat"]>>
  >();
});

/**
 * The whole reason `initSSE` hands back `channel` rather than the package exporting one: the
 * factory is bound to the App's Ctx, so every Authorize this App declares is typed with the very
 * thing this App's `context` builds — and with the params its own pattern names.
 */
test("Authorize is handed the params of its pattern and the context this App builds", () => {
  const { channel } = initSSE({
    transport: createMemoryTransport(),
    context: (request: Request) => ({ role: request.headers.get("x-role") ?? "guest" }),
  });

  const declared = channel({
    pattern: "chat:{roomId}",
    events: { message: messageSchema },
    authorize: (params, ctx) => {
      expectTypeOf(params).toEqualTypeOf<{ roomId: string }>();
      expectTypeOf(ctx).toEqualTypeOf<{ role: string }>();

      return ctx.role === "admin" && params.roomId !== "";
    },
  });

  expect(declared.authorize).toBeTypeOf("function");

  /** Refused by the compiler, and never run. */
  const refused = () => {
    channel({
      pattern: "chat:{roomId}",
      events: { message: messageSchema },
      // @ts-expect-error the pattern names roomId, not room
      authorize: (params: { room: string }) => params.room !== "",
    });
    channel({
      pattern: "chat:{roomId}",
      events: { message: messageSchema },
      // @ts-expect-error this App's context has no such property
      authorize: (_params, ctx) => ctx.admin === true,
    });
    // @ts-expect-error a Channel without Authorize is not a Channel
    channel({ pattern: "chat:{roomId}", events: { message: messageSchema } });
  };
  expect(refused).toBeTypeOf("function");
});

/** Authorize may do the async work a session or a database read takes, and so may `context`. */
test("an async context types Authorize on what it resolves to", () => {
  const { channel } = initSSE({
    transport: createMemoryTransport(),
    context: async (request: Request) => ({ userId: await Promise.resolve(request.url) }),
    key: (ctx) => {
      expectTypeOf(ctx).toEqualTypeOf<{ userId: string }>();

      return ctx.userId;
    },
  });

  channel({
    pattern: "user:{userId}:inbox",
    events: { mail: asType<{ id: string }>() },
    authorize: async (params, ctx) => {
      expectTypeOf(ctx).toEqualTypeOf<{ userId: string }>();

      return Promise.resolve(ctx.userId === params.userId);
    },
  });
});

/** An App with only public Channels writes no `context`, and its Ctx is `undefined` (ADR-0008). */
test("an App that builds no context declares Authorize on undefined", () => {
  const { channel } = initSSE({ transport: createMemoryTransport() });

  channel({
    pattern: "announcements",
    events: { announcement: asType<{ title: string }>() },
    authorize: (params, ctx) => {
      expectTypeOf(params).toEqualTypeOf<Record<never, string>>();
      expectTypeOf(ctx).toEqualTypeOf<undefined>();

      return true;
    },
  });
});
