import { expect, test } from "vitest";

import { openDemoStream, publish } from "./harness/demo.js";
import { assertPromptExit, startInstance } from "./harness/example.js";

/**
 * Revocation end to end, on the built example app: a reader is holding a Connection, an admin
 * calls the demo's own Kick route, and that Connection ends with `reconnect` and comes straight
 * back — Authorized afresh, still streaming.
 *
 * It goes through the ordinary demo feature a reader would copy (ADR-0009): the route is the
 * example's `POST /api/kick`, the stream is a real `EventSource`, and nothing here is a test-only
 * path through the App.
 */
test("an admin Kick ends a Connection, which comes back on its own", async () => {
  const instance = await startInstance();
  const stream = openDemoStream(instance.url);

  try {
    const ready = await stream.next("ready");
    expect(JSON.parse(ready.data)).toMatchObject({ refused: ["admin"] });
    await stream.next("caught-up");

    await expectKick(instance.url, { userId: "anonymous" }, 200);

    /**
     * The Instance says so before it goes, and the client core — here, the browser's own
     * `EventSource` — reopens at once. The second `ready` is the next `GET`, which is where
     * Authorize runs again: a Kick buys nothing but that.
     */
    expect((await stream.next("reconnect")).data).toBe("{}");
    const again = await stream.next("ready");
    expect(JSON.parse(again.data)).toMatchObject({ refused: ["admin"] });
    await stream.next("caught-up");

    /** And it is a Connection like any other: the room it kept goes on carrying its Messages. */
    await publish(instance.url, "the room survived the kick");
    const { channel, payload } = JSON.parse((await stream.next("message")).data) as Envelope;
    expect(channel).toBe("chat:42");
    expect(payload.text).toBe("the room survived the kick");
  } finally {
    stream.close();
    assertPromptExit(await instance.stop());
  }
});

/**
 * Who may Kick is the route's own business: Authorize decides who may *read* a Channel and is
 * never asked about anything else, so a reader without the role is refused here, before a
 * control Entry is written at all.
 */
test("a reader who is not an admin cannot Kick", async () => {
  const instance = await startInstance();

  try {
    await expectKick(instance.url, { userId: "anonymous" }, 403, "");
    await expectKick(instance.url, {}, 400);
  } finally {
    assertPromptExit(await instance.stop());
  }
});

/** As much of a Message as this scenario reads. */
interface Envelope {
  channel: string;
  payload: { text: string };
}

/** One call of the demo's Kick route, as an admin unless the cookie says otherwise. */
async function expectKick(
  url: string,
  body: { userId?: string },
  status: number,
  cookie = "role=admin",
): Promise<void> {
  const response = await fetch(`${url}/api/kick`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });

  expect(response.status).toBe(status);
}
