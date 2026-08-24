import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import type { ChannelDeclaration } from "../internal/channel.js";

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
