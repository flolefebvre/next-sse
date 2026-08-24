import { expect, inject, test } from "vitest";

import { connect, twoInstances } from "./two-instances.js";

/**
 * The claim Kick is for, on a real log: an App revokes on one Instance, and the Connections
 * another Instance holds are the ones that end.
 *
 * Nothing about a Kick is local. `sse.kick()` writes one control Entry, every Instance reads the
 * whole log and acts on what it finds there (ADR-0005), and that is the only reason a revocation
 * on the pod that served the server action reaches the pod that is holding the stream. A
 * Memory-Transport test cannot make this claim: it has one log and one Instance by construction.
 */

test("a Kick from one Instance ends the Connections another Instance holds", async () => {
  const { here, there, close } = await twoInstances(inject("redisUrl"), {
    context: (request) => request.headers.get("x-user") ?? undefined,
    key: (user) => user,
  });

  try {
    const hers = await connect(here, { user: "ada" });
    const his = await connect(here, { user: "sam" });
    expect((await hers.next()).event).toBe("caught-up");
    expect((await his.next()).event).toBe("caught-up");

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
    const subscribed = await connect(here, { user: "ada" });
    expect((await subscribed.next()).event).toBe("caught-up");

    await there.kick(there.chat({ roomId: "42" }));

    expect((await subscribed.next()).event).toBe("reconnect");
  } finally {
    await close();
  }
});

/** The two rooms, so that "the one it keeps" and "the one it loses" can be different Channels. */
const ROOMS = ["chat:42", "chat:7"];

/**
 * What the Kick was for: the App changed its mind about who may read what, and the Connection
 * the other Instance was holding comes back through Authorize rather than back onto its Channels.
 *
 * This is the whole of ADR-0003's revocation, across the seam that makes it necessary: the
 * decision is taken per Channel when a Connection opens and again on every reconnect, so the
 * round trip a Kick costs is what the new answer is applied on — on the Instance that is holding
 * the Connection, which never saw the Kick issued. The Channel that is still allowed is
 * untouched, and the control Entry that ended the first Connection is not replayed into the
 * second, which would drop it again the instant it was let back in.
 */
test("a Connection a Kick from another Instance ended comes back through Authorize", async () => {
  const denied = new Set<string>();
  const { here, there, close } = await twoInstances(inject("redisUrl"), {
    context: (request) => request.headers.get("x-user") ?? undefined,
    key: (user) => user,
    authorize: ({ roomId }) => !denied.has(roomId),
  });

  try {
    const hers = await connect(here, { user: "ada", channels: ROOMS });
    expect(hers.refused).toEqual([]);
    expect((await hers.next()).event).toBe("caught-up");

    /** The App changes its mind on the Instance that is holding nothing, and enforces it there. */
    denied.add("7");
    await there.kick({ key: "ada" });
    expect((await hers.next()).event).toBe("reconnect");

    const back = await connect(here, { user: "ada", after: hers.cursor, channels: ROOMS });
    expect(back.refused).toEqual(["chat:7"]);
    expect((await back.next()).event).toBe("caught-up");

    /**
     * The room she lost carries nothing to her, and the one she kept carries everything: the
     * shared Message is what she reads next, on a Connection that saw the other Publish go by.
     */
    await there.chat({ roomId: "7" }).message({ text: "the room she was refused" });
    await there.chat({ roomId: "42" }).message({ text: "the room she kept" });
    expect(await back.message()).toEqual({ channel: "chat:42", text: "the room she kept" });

    back.leave();
  } finally {
    await close();
  }
});
