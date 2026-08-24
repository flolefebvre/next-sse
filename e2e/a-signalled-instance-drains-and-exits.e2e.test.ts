import { expect, test } from "vitest";

import { openDemoStream } from "./harness/demo.js";
import { startInstance } from "./harness/example.js";

/**
 * The deploy, end to end, on the built example app: a reader is holding a Connection, the
 * orchestrator sends `SIGTERM`, and the process ends its own Connections and exits.
 *
 * This is the one claim that cannot be made anywhere but here. `next start` handles the signal
 * by awaiting `server.close()`, which never closes an active response — so an open SSE stream is
 * exactly what would hold it until the orchestrator's `SIGKILL`, with every client left on a
 * dead socket. The Drain ending the responses is what lets that `close()` resolve, and the two
 * are self-synchronizing because Node runs every listener for a signal: nothing here is
 * configured, and `NEXT_MANUAL_SIG_HANDLE` is never set (ADR-0011).
 *
 * What this reader is not is a browser: the client here reads the stream and stops, where a real
 * one reconnects over the socket it already has and used to hold the process open by doing so
 * (#74). That half of the claim is every browser scenario's, which signal their Instance with the
 * reader still on the page — see `harness/browser.ts`.
 */

/** Comfortably inside the harness's ten-second `SIGKILL` fallback, and outside the 3 s window. */
const PROMPT_MS = 8000;

test("a signalled Instance with an open Connection ends it and exits by itself", async () => {
  const instance = await startInstance();
  const stream = openDemoStream(instance.url);

  try {
    await stream.next("ready");
    await stream.next("caught-up");

    const started = Date.now();
    const stopping = instance.stop();

    /** What the client is told before the process goes: come back, and bring your Cursor. */
    expect((await stream.next("reconnect")).data).toBe("{}");

    const exit = await stopping;
    expect(exit.forced).toBe(false);
    expect(exit.signal).toBeNull();
    /** The status Next.js exits with when it handled the `SIGTERM` itself. */
    expect(exit.code).toBe(143);
    expect(Date.now() - started).toBeLessThan(PROMPT_MS);
  } finally {
    stream.close();
    await instance.stop();
  }
});
