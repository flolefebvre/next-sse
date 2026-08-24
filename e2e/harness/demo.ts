import { openStream, type Stream } from "./stream.js";

/**
 * The example app's own features, as a scenario drives them.
 *
 * They live here because several scenarios drive the same ones and a second spelling of "publish
 * into the room" would be a second opinion on what the demo does. Everything below is a route a
 * reader of the example would copy: there is no test-only path through this App (ADR-0009).
 */

/** The Channels the demo page subscribes to: the room, and the admin Channel most readers lose. */
const DEMO_CHANNELS = "channel=chat:42&channel=admin";

/** One reader of the demo page, holding the Connection that page holds. */
export function openDemoStream(url: string): Stream {
  return openStream(`${url}/api/sse?${DEMO_CHANNELS}`);
}

/** One Message into the room, through the demo's own webhook. */
export async function publish(url: string, text: string): Promise<void> {
  const response = await fetch(`${url}/api/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error(
      `the demo's webhook answered ${String(response.status)} rather than publishing`,
    );
  }
}
