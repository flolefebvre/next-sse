import { expect, inject, test } from "vitest";

import { messageOf } from "../packages/next-sse/src/server/frames.testkit.js";

import { connect, twoInstances, type Client, type TwoInstances } from "./two-instances.js";

/**
 * The claim the whole library rests on, on a real log: a Message Published on one Instance
 * reaches the Connections another Instance is holding, and the Instance that published it is of
 * no consequence to anybody.
 *
 * It is the shape of a deployment behind a load balancer — the server action runs on the pod the
 * POST landed on, the stream lives on the pod the GET landed on, and the two are almost never
 * the same. Every Instance reads the one log in full (ADR-0005), so a Connection is fed from the
 * log rather than from whatever happened locally, and that is what makes the two indistinguishable.
 * A Memory-Transport test cannot make this claim: it has one log and one Instance by construction.
 */

/** One Message as a Connection read it: the Cursor it carried, its Channel and its text. */
interface Read {
  id: string | undefined;
  channel: string;
  text: string;
}

/** The next `count` Messages off a Connection, refusing a Control event the way `messageOf` does. */
async function read(client: Client, count: number): Promise<Read[]> {
  const messages: Read[] = [];
  for (let i = 0; i < count; i++) {
    const frame = await client.next();
    messages.push({ id: frame.id, ...messageOf(frame) });
  }

  return messages;
}

/**
 * Two Instances of the App holding one Connection each, both caught up on the room they share:
 * the smallest deployment in which "which Instance Published it" is a question at all.
 */
async function oneOnEach(): Promise<TwoInstances & { hers: Client; his: Client }> {
  const instances = await twoInstances(inject("redisUrl"));

  try {
    const hers = await connect(instances.here);
    const his = await connect(instances.there);
    expect((await hers.next()).event).toBe("caught-up");
    expect((await his.next()).event).toBe("caught-up");

    return { ...instances, hers, his };
  } catch (failure) {
    await instances.close();

    throw failure;
  }
}

test("a Message Published on one Instance reaches the Connections the other one holds", async () => {
  const { here, there, hers, his, close } = await oneOnEach();

  try {
    /** Published on the Instance that holds one of the two Connections, and read by both. */
    await here.chat({ roomId: "42" }).message({ text: "from the Instance she is on" });
    expect(await hers.message()).toEqual({
      channel: "chat:42",
      text: "from the Instance she is on",
    });
    expect(await his.message()).toEqual({
      channel: "chat:42",
      text: "from the Instance she is on",
    });

    /** And the other way round, which is the same claim with the Instances swapped. */
    await there.chat({ roomId: "42" }).message({ text: "from the Instance he is on" });
    expect(await hers.message()).toEqual({
      channel: "chat:42",
      text: "from the Instance he is on",
    });
    expect(await his.message()).toEqual({ channel: "chat:42", text: "from the Instance he is on" });

    hers.leave();
    his.leave();
  } finally {
    await close();
  }
});

/**
 * What a Connection on either Instance reads is the log itself: the same Entries, in the order
 * the Transport gave them, once each.
 *
 * The Publishes are issued together rather than in turn, so the order is the log's own and not
 * the test's: the Cursor every Publish came back with says where the Transport put it, and the
 * claim is that both Connections read those Cursors in one and the same order — the Transport's
 * ordering under concurrent writers is the contract suite's claim ("a peer's Publish reaches
 * this Instance's subscription, in order with its own"), and this is the Instance-level half of
 * it, that nothing between the log and the wire reorders, drops or repeats an Entry.
 */
test("both Instances carry the one log to their Connections, in its order and once each", async () => {
  const { here, there, hers, his, close } = await oneOnEach();

  try {
    const texts = ["one", "two", "three", "four", "five", "six"];
    const cursors = await Promise.all(
      texts.map((text, i) => (i % 2 === 0 ? here : there).chat({ roomId: "42" }).message({ text })),
    );

    const byHer = await read(hers, texts.length);
    const byHim = await read(his, texts.length);

    /** The one order: whatever the log settled on, both Connections read it. */
    expect(byHim).toEqual(byHer);

    /** Every Message once, and each one under the Cursor its own Publish came back with. */
    expect(Object.fromEntries(byHer.map(({ text, id }) => [text, id]))).toEqual(
      Object.fromEntries(texts.map((text, i) => [text, cursors[i]])),
    );
    /** And neither Connection is owed anything else: the next frame is the next Publish. */
    await there.chat({ roomId: "42" }).message({ text: "and nothing in between" });
    expect(await hers.message()).toEqual({ channel: "chat:42", text: "and nothing in between" });
    expect(await his.message()).toEqual({ channel: "chat:42", text: "and nothing in between" });

    hers.leave();
    his.leave();
  } finally {
    await close();
  }
});

/**
 * The other side of fan-out: the log reaches every Instance whole, and what narrows it to a
 * Connection is that Connection's own subscription — not the Instance it happens to be held by.
 */
test("an Instance carries a Message only to the Connections that subscribed to its Channel", async () => {
  const { here, there, close } = await twoInstances(inject("redisUrl"));

  try {
    const inBoth = await connect(there, { channels: ["chat:42", "chat:7"] });
    const inOne = await connect(here, { channels: ["chat:42"] });
    expect((await inBoth.next()).event).toBe("caught-up");
    expect((await inOne.next()).event).toBe("caught-up");

    await here.chat({ roomId: "7" }).message({ text: "for the other room" });
    await there.chat({ roomId: "42" }).message({ text: "for the room they share" });

    expect(await inBoth.message()).toEqual({ channel: "chat:7", text: "for the other room" });
    expect(await inBoth.message()).toEqual({ channel: "chat:42", text: "for the room they share" });

    /**
     * The Connection that never asked for the other room reads the shared Message first: the
     * Entry it was not subscribed to reached its Instance and stopped there.
     */
    expect(await inOne.message()).toEqual({ channel: "chat:42", text: "for the room they share" });

    inBoth.leave();
    inOne.leave();
  } finally {
    await close();
  }
});
