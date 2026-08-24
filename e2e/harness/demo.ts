import { openStream, type Stream } from "./stream.js";

/**
 * The example app's own features, as a scenario drives them.
 *
 * They live here because several scenarios drive the same ones and a second spelling of "publish
 * into the room" would be a second opinion on what the demo does. Everything below is a route a
 * reader of the example would copy: there is no test-only path through this App (ADR-0009).
 */

/** The room the demo page shows, and the one the webhook Publishes into unless told otherwise. */
export const DEMO_ROOM = "42";

/**
 * The Channels of the demo page these scenarios drive: the room, and the admin Channel most
 * readers lose. The page subscribes to more than these — the broadcast, and the reader's own
 * notifications — and a scenario about one of those asks for it by itself.
 */
const DEMO_CHANNELS = [`chat:${DEMO_ROOM}`, "admin"];

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
  return openChannels(url, DEMO_CHANNELS, cursor);
}

/**
 * One reader of several rooms at once, which is what makes "per Channel" mean anything: the
 * Registry's `chat:{roomId}` is a family of Channels, and one Connection carries as many of
 * them as its reader asks for, under the one Cursor they share (ADR-0001).
 */
export function openRoomsStream(url: string, rooms: string[], cursor?: string): Stream {
  return openChannels(
    url,
    rooms.map((room) => `chat:${room}`),
    cursor,
  );
}

/**
 * One reader of the demo's broadcast, and nothing else: the Channel every reader of the App is
 * on, which is the one a publisher outside Next.js writes to in this demo.
 */
export function openBroadcastStream(url: string): Stream {
  return openChannels(url, ["announcements"]);
}

/** The demo's SSE route, asked for these Channels, resuming when the caller has a position. */
function openChannels(url: string, channels: string[], cursor?: string): Stream {
  const query = channels.map((channel) => `channel=${channel}`);
  if (cursor !== undefined) query.push(`cursor=${encodeURIComponent(cursor)}`);

  return openStream(`${url}/api/sse?${query.join("&")}`);
}

/** One Message into a room — the demo's own, unless another is named — through its webhook. */
export async function publish(url: string, text: string, roomId?: string): Promise<void> {
  const response = await fetch(`${url}/api/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(roomId === undefined ? { text } : { text, roomId }),
  });

  if (!response.ok) {
    throw new Error(
      `the demo's webhook answered ${String(response.status)} rather than publishing`,
    );
  }
}

/** One Message off a Connection, as much of it as a scenario about the demo reads. */
export interface Delivered {
  channel: string;
  text: string;
  /** Where the Connection now stands: the position this Message came with, and nowhere else. */
  cursor: string;
}

/**
 * The next Message off a Connection, read the way the demo's page reads one: its Channel, the
 * text a reader would see, and the position it carries. What the envelope holds besides is the
 * Publish scenario's business, and reading it here would be a second opinion on the wire.
 */
export async function nextMessage(stream: Stream, timeoutMs?: number): Promise<Delivered> {
  const received = await stream.next("message", timeoutMs);
  const { channel, payload } = JSON.parse(received.data) as {
    channel: string;
    payload: { text: string };
  };

  return { channel, text: payload.text, cursor: received.lastEventId };
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
