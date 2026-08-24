import { expect, test } from "vitest";

import { kick, openDemoStream, publish } from "./harness/demo.js";
import { twoInstances } from "./harness/example.js";

/**
 * Revocation across a deployment: an admin calls the Kick route on the Instance a load balancer
 * happened to give them, and a Connection held by the *other* Instance ends and comes back
 * Authorized afresh.
 *
 * This is the reason a Kick is an Entry in the log rather than a call: the Instance that takes
 * the request holds none of the Connections it is about, and has no way to reach them
 * (ADR-0003). What it promises the caller is that the revocation is written; what closes the
 * Connections is whichever Instance holds them, on the far side of the log.
 */
test("a Kick called on one Instance ends a Connection held by the other", async () => {
  const app = await twoInstances();
  const reader = openDemoStream(app.here.url);

  try {
    expect(JSON.parse((await reader.next("ready")).data)).toMatchObject({ refused: ["admin"] });
    await reader.next("caught-up");

    const kicked = await kick(app.there.url, { userId: "anonymous" });
    expect(kicked.status).toBe(200);

    /**
     * The Instance holding the Connection ends it with `reconnect` — never a dead socket — and
     * the `EventSource` comes straight back to the same Instance, where Authorize runs again on
     * a session that has not changed: the room is kept, the admin Channel is refused again.
     */
    expect((await reader.next("reconnect")).data).toBe("{}");
    expect(JSON.parse((await reader.next("ready")).data)).toMatchObject({ refused: ["admin"] });
    await reader.next("caught-up");

    /** And it is a Connection like any other: what the other Instance Publishes still reaches it. */
    await publish(app.there.url, "the room survived a Kick from the other Instance");
    const { channel, payload } = JSON.parse((await reader.next("message")).data) as Envelope;
    expect(channel).toBe("chat:42");
    expect(payload.text).toBe("the room survived a Kick from the other Instance");
  } finally {
    reader.close();
    await app.stop();
  }
});

/** As much of a Message as this scenario reads. */
interface Envelope {
  channel: string;
  payload: { text: string };
}
