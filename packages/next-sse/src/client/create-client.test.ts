import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import type { ChannelDeclaration } from "../internal/channel.js";

import type { Snapshot } from "../internal/snapshot.js";

import type { SSEClient } from "./create-client.js";
import type { Channels, Handle, Handlers } from "./handle.js";

/**
 * The client's half of ADR-0002, as a type test: a Client Component knows the App's Channels
 * because the Registry reached it through `import type`, and nothing else of it exists here.
 * That is why this file imports types only — the module it checks is `'use client'`, and its
 * `client` below is a declaration with no value behind it. Everything that would call one is
 * written inside a function that is checked and never run.
 */
const messageSchema = z.object({ text: z.string(), sentAt: z.iso.datetime() });

type Chat = ChannelDeclaration<"chat:{roomId}", { message: typeof messageSchema }>;
type Announcements = ChannelDeclaration<"announcements", { announcement: typeof messageSchema }>;
type App = { channels: { chat: Chat; announcements: Announcements } };

declare const client: SSEClient<App>;
declare const snapshot: Snapshot<{ text: string; sentAt: string }[]>;

test("a Channel is addressed by its key, with the params its pattern names", () => {
  expectTypeOf<Channels<App>["chat"]>().parameters.toEqualTypeOf<[params: { roomId: string }]>();
  expectTypeOf<Channels<App>["announcements"]>().parameters.toEqualTypeOf<[]>();
  expectTypeOf<ReturnType<Channels<App>["chat"]>>().toEqualTypeOf<Handle<"chat">>();
});

/** What a handler receives is what the Publish validated: the schema's Output (ADR-0006). */
test("a handler receives the payload its event carries", () => {
  expect(messageSchema["~standard"].vendor).toBe("zod");
  expectTypeOf<Handlers<{ message: typeof messageSchema }>>().toEqualTypeOf<{
    message?: (payload: { text: string; sentAt: string }) => void;
  }>();

  const subscribed = () => {
    client.useChannel(client.channels.chat({ roomId: "42" }), {
      message: (payload) => {
        expectTypeOf(payload).toEqualTypeOf<{ text: string; sentAt: string }>();
      },
    });
    client.useChannel(client.channels.announcements(), {});
  };

  expect(subscribed).toBeTypeOf("function");
});

/** An event with no handler is ignored; an event that does not exist is a mistake. */
test("only the events the Channel carries can be handled", () => {
  const refused = () => {
    client.useChannel(client.channels.chat({ roomId: "42" }), {
      // @ts-expect-error the Channel carries no such event
      shout: () => undefined,
    });
    client.useChannel(client.channels.chat({ roomId: "42" }), {
      // @ts-expect-error the payload is what the schema produced, not what a component wishes
      message: (payload: { text: number }) => void payload,
    });
    // @ts-expect-error a Channel with params cannot be addressed without them
    client.useChannel(client.channels.chat(), {});
    // @ts-expect-error this App has no such Channel
    client.useChannel(client.channels.nope(), {});
  };

  expect(refused).toBeTypeOf("function");
});

/**
 * `useChannelState` reads its events off the same Registry type `useChannel` does — there is no
 * type parameter on a Handle to carry them — and its state comes from the Snapshot alone.
 */
test("the state hook is typed by the Snapshot's data and the Channel's events", () => {
  const held = () => {
    const room = client.useChannelState(client.channels.chat({ roomId: "42" }), snapshot, {
      message: (state, payload) => {
        expectTypeOf(state).toEqualTypeOf<{ text: string; sentAt: string }[]>();
        expectTypeOf(payload).toEqualTypeOf<{ text: string; sentAt: string }>();

        return state;
      },
    });

    expectTypeOf(room.state).toEqualTypeOf<{ text: string; sentAt: string }[]>();
    expectTypeOf(room.pending.message).toEqualTypeOf<{ text: string; sentAt: string }[]>();
    expectTypeOf(room.inFlight).toEqualTypeOf<boolean>();
    room.apply("message", { text: "applied", sentAt: "2026-01-01T00:00:00Z" });
    room.act("message", null, async () => ({ text: "sent", sentAt: "2026-01-01T00:00:00Z" }));
  };

  expect(held).toBeTypeOf("function");
});

test("only the events the Channel carries can be reduced, applied or acted on", () => {
  const refused = () => {
    client.useChannelState(client.channels.chat({ roomId: "42" }), snapshot, {
      // @ts-expect-error the Channel carries no such event
      shout: (state: unknown) => state,
    });
    const room = client.useChannelState(client.channels.chat({ roomId: "42" }), snapshot, {});
    // @ts-expect-error an optimistic payload has the event's wire shape
    room.act("message", { text: "no date" }, async () => ({ text: "", sentAt: "" }));
    client.useChannelState(client.channels.chat({ roomId: "42" }), snapshot, {
      // @ts-expect-error the reducer must give back the state's own type
      message: () => "not a list",
    });
  };

  expect(refused).toBeTypeOf("function");
});
