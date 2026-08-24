import { expect, inject, test } from "vitest";

import { TransportClosedError } from "../packages/next-sse/src/transport/index.js";

import { connect, twoInstances } from "./two-instances.js";

/**
 * The claim Drain is for, on a real log: the Instance a client is on goes away, and the client
 * comes back on another one having missed nothing.
 *
 * It is the deploy this library exists to survive. The Instance that is signalled ends its
 * Connections with `reconnect` — never a dead socket — and the client core comes straight back
 * with its Cursor; what was published before the cut and what was published while it was between
 * Connections are both in the log the surviving Instance reads, so it is replayed exactly once
 * and goes on live (ADR-0011). A Memory-Transport test cannot make this claim: it has one log
 * and one Instance by construction.
 */
test("a client cut by a Drain comes back on another Instance and loses nothing", async () => {
  const { here, there, close } = await twoInstances(inject("redisUrl"), { drain: 0 });

  try {
    const client = await connect(here);
    expect((await client.next()).event).toBe("caught-up");

    await here.chat({ roomId: "42" }).message({ text: "before the drain" });
    expect(await client.message()).toEqual({ channel: "chat:42", text: "before the drain" });

    /**
     * The Instance is drained the way a signal drains it, and this is what the client sees: the
     * Control event that means "come back", rather than the stream simply dying.
     */
    await here.drain();
    expect((await client.next()).event).toBe("reconnect");
    await expect(client.next()).rejects.toThrow(/stream ended/);

    /**
     * Published on the survivor while the client is between two Connections: the window a Cursor
     * exists for, and the one a Drain that closed the log first would have lost.
     */
    await there.chat({ roomId: "42" }).message({ text: "while it was away" });

    const again = await connect(there, { after: client.cursor });
    expect(again.refused).toEqual([]);
    expect(await again.message()).toEqual({ channel: "chat:42", text: "while it was away" });
    expect((await again.next()).event).toBe("caught-up");

    /** And nothing is delivered twice: what it had already read is not replayed to it. */
    await there.chat({ roomId: "42" }).message({ text: "and on it goes" });
    expect(await again.message()).toEqual({ channel: "chat:42", text: "and on it goes" });

    again.leave();
  } finally {
    await close();
  }
});

/**
 * The other half of the same shutdown, and the reason the Drain closes the Transport last: an
 * Instance on its way out still serves the server actions that were in flight when the signal
 * arrived, and what it closes afterwards is its own Transport and nobody else's — the App's log
 * outlives it, which is what the clients it just cut come back to (ADR-0011).
 */
test("a Publish made while an Instance drains lands, and the log outlives that Instance", async () => {
  const { here, there, close } = await twoInstances(inject("redisUrl"), { drain: 1000 });

  try {
    const client = await connect(here);
    expect((await client.next()).event).toBe("caught-up");

    /**
     * The Publish is issued in the same tick as the Drain, which is what an in-flight server
     * action is: the log is open until the last Connection has gone, so it lands and is carried
     * to a client this Instance has not ended yet.
     */
    const draining = here.drain();
    await here.chat({ roomId: "42" }).message({ text: "in flight when the signal came" });
    expect(await client.message()).toEqual({
      channel: "chat:42",
      text: "in flight when the signal came",
    });

    expect((await client.next()).event).toBe("reconnect");
    await draining;

    /** Past its own close, this Instance publishes nothing: it is gone (ADR-0005). */
    await expect(here.chat({ roomId: "42" }).message({ text: "too late" })).rejects.toBeInstanceOf(
      TransportClosedError,
    );

    const again = await connect(there, { after: client.cursor });
    expect((await again.next()).event).toBe("caught-up");
    await there.chat({ roomId: "42" }).message({ text: "the App carries on" });
    expect(await again.message()).toEqual({ channel: "chat:42", text: "the App carries on" });

    again.leave();
  } finally {
    await close();
  }
});
