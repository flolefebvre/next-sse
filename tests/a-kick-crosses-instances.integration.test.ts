import { expect, inject, test } from "vitest";

import { framesOf, type Frame } from "../packages/next-sse/src/server/frames.testkit.js";
import type { ChatApp } from "../packages/next-sse/src/server/chat-app.testkit.js";

import { twoInstances } from "./two-instances.js";

/**
 * The claim Kick is for, on a real log: an App revokes on one Instance, and the Connections
 * another Instance holds are the ones that end.
 *
 * Nothing about a Kick is local. `sse.kick()` writes one control Entry, every Instance reads the
 * whole log and acts on what it finds there (ADR-0005), and that is the only reason a revocation
 * on the pod that served the server action reaches the pod that is holding the stream. A
 * Memory-Transport test cannot make this claim: it has one log and one Instance by construction.
 */

/** One Connection on this Instance, opened as `user`, reading its opening sequence. */
async function connect(
  sse: ChatApp,
  user: string,
): Promise<{ next: () => Promise<Frame>; leave: () => void }> {
  const client = new AbortController();
  const response = await sse.handlers.GET(
    new Request("http://example.test/api/sse?channel=chat:42", {
      signal: client.signal,
      headers: { "x-user": user },
    }),
  );
  expect(response.status).toBe(200);

  const frames = framesOf(response);
  expect((await frames.next()).event).toBe("ready");
  expect((await frames.next()).retry).toBe("3000");
  expect((await frames.next()).event).toBe("caught-up");

  return {
    next: () => frames.next(),
    leave: () => {
      client.abort();
    },
  };
}

test("a Kick from one Instance ends the Connections another Instance holds", async () => {
  const { here, there, close } = await twoInstances(inject("redisUrl"), {
    context: (request) => request.headers.get("x-user") ?? undefined,
    key: (user) => user,
  });

  try {
    const hers = await connect(here, "ada");
    const his = await connect(here, "sam");

    /** The Kick is written on the Instance that never saw either Connection. */
    await there.kick({ key: "ada" });

    expect((await hers.next()).event).toBe("reconnect");

    /**
     * His Connection is on the same Instance and the same log, and the Kick named somebody else:
     * it goes on carrying a Message published from the other Instance, which is the fan-out this
     * same log gives every Entry.
     */
    await there.chat({ roomId: "42" }).message({ text: "his Connection is untouched" });
    const message = await his.next();
    expect(message.event).toBeUndefined();
    expect(JSON.parse(message.data ?? "{}")).toMatchObject({
      channel: "chat:42",
      payload: { text: "his Connection is untouched" },
    });

    his.leave();
  } finally {
    await close();
  }
});

/**
 * The other target, across the same seam: a bound Handle names a Channel, and every Connection
 * subscribed to it ends, on whichever Instance is holding it.
 */
test("a Kick of a Handle from one Instance ends the Connections another Instance holds on it", async () => {
  const { here, there, close } = await twoInstances(inject("redisUrl"));

  try {
    const subscribed = await connect(here, "ada");

    await there.kick(there.chat({ roomId: "42" }));

    expect((await subscribed.next()).event).toBe("reconnect");
  } finally {
    await close();
  }
});
