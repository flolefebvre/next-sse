import { expect, test } from "vitest";

import { nextMessage, openDemoStream, publish } from "./harness/demo.js";
import { twoInstances } from "./harness/example.js";
import type { Stream } from "./harness/stream.js";

/**
 * The Cursor, taken from the protocol and spent on another Instance: a reader opens a
 * Connection, reads its position out of `ready`, closes, and comes back on the *other* Instance
 * with it — receiving everything Published while it was away, exactly once, before the live feed
 * takes over.
 *
 * That opening move is the only way a headless scenario is allowed to hold a Cursor (ADR-0009):
 * open, read `ready`, close. The page embeds a Snapshot with a Cursor in it and a scenario could
 * fish it out of the RSC payload — which would couple these tests to Next.js internals and to a
 * value ADR-0007 says is opaque. The protocol hands it over in the open.
 */
test("a Cursor read from `ready` on one Instance replays on the other", async () => {
  const app = await twoInstances();
  const first = openDemoStream(app.here.url);
  let resumed: Stream | undefined;

  try {
    const { cursor } = JSON.parse((await first.next("ready")).data) as { cursor: string };
    expect(cursor).not.toBe("");
    await first.next("caught-up");
    first.close();

    /** Published on both Instances while nobody holds a Connection: the window a Cursor is for. */
    await publish(app.here.url, "while it was away");
    await publish(app.there.url, "and from the other Instance");

    resumed = openDemoStream(app.there.url, cursor);
    const again = JSON.parse((await resumed.next("ready")).data) as { cursor: string };
    expect(again.cursor).toBe(cursor);

    expect(await nextMessage(resumed)).toEqual(inTheRoom("while it was away"));
    expect(await nextMessage(resumed)).toEqual(inTheRoom("and from the other Instance"));

    /** The replay is over, and it ended where the log did: nothing of it comes round again. */
    await resumed.next("caught-up");
    await publish(app.here.url, "and on it goes");
    expect(await nextMessage(resumed)).toEqual(inTheRoom("and on it goes"));
  } finally {
    first.close();
    resumed?.close();
    await app.stop();
  }
});

/** What a Message read off this reader's Connection is expected to be: the room, and a text. */
const inTheRoom = (text: string): { channel: string; text: string } => ({
  channel: "chat:42",
  text,
});
