import { expect, test } from "vitest";

import { openDemoStream, publish } from "./harness/demo.js";
import { twoInstances } from "./harness/example.js";

/**
 * The claim the whole library is for, on the real thing: two Instances of the built example app
 * behind one log, a reader on each, and a Publish made on one of them reaching both.
 *
 * Nothing in the App knows there are two: the webhook Publishes through the same bound Handle it
 * would on a single Instance, and the Instance that took the call is not the one holding the
 * other Connection. Every Instance reads the App's log in full and writes to the Connections it
 * happens to hold, which is the whole of the fan-out (ADR-0005) — and it can only be seen with
 * two processes, two Connection tables and two subscriptions, which is what this project has and
 * the integration one approximates in a single process (ADR-0009).
 */
test("a Publish made on one Instance reaches readers on both", async () => {
  const app = await twoInstances();
  const readers = [openDemoStream(app.here.url), openDemoStream(app.there.url)];

  try {
    for (const reader of readers) {
      expect(JSON.parse((await reader.next("ready")).data)).toMatchObject({
        cursor: expect.any(String),
        refused: ["admin"],
      });
      await reader.next("caught-up");
    }

    await publish(app.there.url, "published on the other Instance");

    for (const reader of readers) {
      const { channel, payload } = JSON.parse((await reader.next("message")).data) as Envelope;
      expect(channel).toBe("chat:42");
      expect(payload.text).toBe("published on the other Instance");
    }

    /**
     * The next Publish, from the other side, is what makes the first one exactly once: were a
     * Message delivered twice, this read would find the echo rather than what follows it.
     */
    await publish(app.here.url, "and back the other way");

    for (const reader of readers) {
      const { payload } = JSON.parse((await reader.next("message")).data) as Envelope;
      expect(payload.text).toBe("and back the other way");
    }
  } finally {
    for (const reader of readers) reader.close();
    await app.stop();
  }
});

/** As much of a Message as this scenario reads. */
interface Envelope {
  channel: string;
  payload: { text: string };
}
