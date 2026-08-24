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

/**
 * One reader of the demo page, holding the Connection that page holds — resuming from a Cursor
 * when it has one.
 *
 * The Cursor travels on the query rather than in `Last-Event-ID` because an `EventSource` sends
 * no headers of its own devising; the header is what the browser echoes back on *its* reconnect,
 * and it wins over the query when both are there (ADR-0004). What a scenario must never do is
 * take that Cursor from anywhere but the protocol: it is opaque (ADR-0007), and the page's
 * Snapshot is not a place to read one from (ADR-0009).
 */
export function openDemoStream(url: string, cursor?: string): Stream {
  const resuming = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;

  return openStream(`${url}/api/sse?${DEMO_CHANNELS}${resuming}`);
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

/**
 * The next Message off a Connection, read the way the demo's page reads one: its Channel, and
 * the text a reader would see. Anything else the envelope carries is the Publish scenario's
 * business, and a scenario that reads it here would be a second opinion on the wire.
 */
export async function nextMessage(
  stream: Stream,
  timeoutMs?: number,
): Promise<{ channel: string; text: string }> {
  const { channel, payload } = JSON.parse((await stream.next("message", timeoutMs)).data) as {
    channel: string;
    payload: { text: string };
  };

  return { channel, text: payload.text };
}

/**
 * One call of the demo's admin Kick route, as an admin unless the cookie says otherwise. What
 * comes back is the answer itself: who the route refuses is as much of the demo as who it
 * Kicks, and different scenarios read different halves of that.
 */
export function kick(
  url: string,
  body: { userId?: string },
  cookie = "role=admin",
): Promise<Response> {
  return fetch(`${url}/api/kick`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}
