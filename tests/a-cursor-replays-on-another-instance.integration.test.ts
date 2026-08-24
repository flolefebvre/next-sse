import { expect, inject, test } from "vitest";

import { messageOf } from "../packages/next-sse/src/server/frames.testkit.js";

import { connect, twoInstances, type Client } from "./two-instances.js";

/**
 * What a Cursor is worth on a real log: a client that got one from an Instance hands it to
 * another Instance and is caught up from there, gap-free.
 *
 * It is the guarantee a load balancer makes necessary. A Cursor is minted by the Transport and
 * names a position in the App's one log (ADR-0001, ADR-0005), not a position in whatever the
 * Instance that handed it out remembers — so the Instance that takes the reconnect replays the
 * same Entries the first one would have, whoever Published them, and stops exactly where the
 * client had already got to. A Memory-Transport test cannot make this claim: it has one log and
 * one Instance by construction.
 */

/** Everything a Connection is replayed, up to the `caught-up` that ends the replay. */
async function replayed(client: Client): Promise<{ channel: string; text: string }[]> {
  const messages: { channel: string; text: string }[] = [];
  for (;;) {
    const frame = await client.next();
    if (frame.event === "caught-up") return messages;

    messages.push(messageOf(frame));
  }
}

const ROOMS = ["chat:42", "chat:7"];

test("a Cursor from one Instance replays on the other, gap-free and once each", async () => {
  const { here, there, close } = await twoInstances(inject("redisUrl"));

  try {
    const client = await connect(here, { channels: ROOMS });
    expect((await client.next()).event).toBe("caught-up");

    /** Read live on the first Instance, so its Cursor is a position this client is past. */
    await here.chat({ roomId: "42" }).message({ text: "read before it left" });
    expect(await client.message()).toEqual({ channel: "chat:42", text: "read before it left" });
    const left = client.cursor;
    client.leave();

    /**
     * The window the Cursor exists for, written from both Instances and on both rooms: what the
     * replay owes this client is the log, not the Instance it comes back on.
     */
    await there.chat({ roomId: "42" }).message({ text: "missed, from the other Instance" });
    await here.chat({ roomId: "7" }).message({ text: "missed, from the first one" });
    await there.chat({ roomId: "7" }).message({ text: "missed, on the other room" });

    const again = await connect(there, { after: left, channels: ROOMS });
    expect(again.refused).toEqual([]);
    expect(await replayed(again)).toEqual([
      { channel: "chat:42", text: "missed, from the other Instance" },
      { channel: "chat:7", text: "missed, from the first one" },
      { channel: "chat:7", text: "missed, on the other room" },
    ]);

    /** And the cut from replay to live is exact: what comes next is the next Publish, once. */
    await here.chat({ roomId: "7" }).message({ text: "live, past the replay" });
    expect(await again.message()).toEqual({ channel: "chat:7", text: "live, past the replay" });
    again.leave();
  } finally {
    await close();
  }
});

/**
 * The same seam at its narrowest: a Cursor a Connection was given and never moved on — the tail
 * of the log as the first Instance read it — is a position the second Instance replays from
 * just as well, with nothing before it and nothing lost after it.
 */
test("a Cursor minted on one Instance and never moved on replays on the other", async () => {
  const { here, there, close } = await twoInstances(inject("redisUrl"));

  try {
    await here.chat({ roomId: "42" }).message({ text: "before this client existed" });

    const client = await connect(here, { channels: ROOMS });
    expect((await client.next()).event).toBe("caught-up");
    client.leave();

    await there.chat({ roomId: "42" }).message({ text: "while it was away" });

    const again = await connect(there, { after: client.cursor, channels: ROOMS });
    expect(await replayed(again)).toEqual([{ channel: "chat:42", text: "while it was away" }]);

    again.leave();
  } finally {
    await close();
  }
});
