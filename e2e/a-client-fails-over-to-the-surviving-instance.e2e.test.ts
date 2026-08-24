import { expect, test } from "vitest";

import { DEMO_ROOM, nextMessage, openDemoStream, publish } from "./harness/demo.js";
import { assertPromptExit, twoInstances } from "./harness/example.js";
import { startProxy } from "./harness/proxy.js";

/**
 * The rolling deploy, whole: a reader holds a Connection through the one address its browser
 * knows, the Instance behind that address is taken out, the address moves to the survivor, and
 * the reader comes back there having missed nothing and seen nothing twice.
 *
 * Every part of it is somebody else's claim on its own — the Drain ends Connections with
 * `reconnect` (ADR-0011), the Cursor replays what was Published in between (ADR-0001), Authorize
 * runs again on the new Connection (ADR-0003) — and this is the one place they are made to hold
 * together, against two real processes with a load balancer in front. The client is never told
 * any of it: it holds one URL, and an `EventSource` that reopens by itself.
 */
test("a reader whose Instance is taken out comes back on the survivor with no gap", async () => {
  const app = await twoInstances();
  const proxy = await startProxy(app.here.url);
  const reader = openDemoStream(proxy.url);

  try {
    await reader.next("ready");
    await reader.next("caught-up");

    await publish(app.here.url, "before the deploy");
    expect(await nextMessage(reader)).toEqual(inTheRoom("before the deploy"));

    /**
     * The deploy, in the order an orchestrator does it: the address stops pointing at the
     * Instance that is going, and only then is it signalled. What the reader sees of it is a
     * `reconnect` on the stream it is holding.
     */
    proxy.sendTo(app.there.url);
    const stopping = app.here.stop();
    expect((await reader.next("reconnect")).data).toBe("{}");
    assertPromptExit(await stopping);

    /**
     * Published on the survivor while the reader is between two Connections: the window the
     * Cursor exists for, and the one a client on a dead socket would have lost silently.
     */
    await publish(app.there.url, "while it was away");

    /**
     * It comes back by itself, through the same address, carrying in `Last-Event-ID` the
     * position of the last Message it read — the browser's own reconnect, which is why nothing
     * in this scenario spells a Cursor out.
     */
    await reader.next("ready", RECONNECT_TIMEOUT_MS);
    expect(await nextMessage(reader)).toEqual(inTheRoom("while it was away"));
    await reader.next("caught-up");

    /** And on the survivor it is an ordinary Connection: live again, with no echo of the replay. */
    await publish(app.there.url, "and the deploy is over");
    expect(await nextMessage(reader)).toEqual(inTheRoom("and the deploy is over"));
  } finally {
    reader.close();
    await proxy.close();
    await app.stop();
  }
});

/**
 * Long enough for the `retry:` the Instance sent (three seconds, ADR-0004) plus the survivor's
 * answer: the wait is the client core's own reconnect delay, not a guess about a machine.
 */
const RECONNECT_TIMEOUT_MS = 15_000;

/**
 * What a Message read off this reader's Connection is expected to be: the room, the text, and a
 * position of its own — the one its reader would come back with.
 */
const inTheRoom = (text: string) => ({
  channel: `chat:${DEMO_ROOM}`,
  text,
  cursor: expect.any(String),
});
