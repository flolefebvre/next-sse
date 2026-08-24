import { beforeEach, expect, test } from "vitest";

import { chatApp, type ChatApp } from "../packages/next-sse/src/server/chat-app.testkit.js";
import { framesOf, type Frames } from "../packages/next-sse/src/server/frames.testkit.js";
import type { Cursor } from "../packages/next-sse/src/transport/index.js";

/**
 * Revocation whole, through the real handler: an App changes its mind about who may read what,
 * Kicks the Connections that Key holds, and the clients come straight back with their Cursors.
 *
 * The claim is the one ADR-0003 makes and nothing weaker: the cut costs a round trip and never a
 * Message on a Channel that is still authorized, the Channel that is not comes back `refused` on
 * its own, and the Kick that ended the first Connection is not replayed to the second — which
 * would drop it again the instant it was let back in.
 */

/** The two rooms, so that "the one it keeps" and "the one it loses" can be different Channels. */
const KEPT = "42";
const LOST = "7";

beforeEach(() => {
  const globals = globalThis as unknown as { [key: symbol]: unknown };
  delete globals[Symbol.for("@flefebvre/next-sse")];
});

/** One App whose Authorize a scenario can change its mind about, mid-run. */
interface App {
  sse: ChatApp;
  /** Take a room away from everyone, the way an App revokes a membership. */
  revoke(room: string): void;
}

const anApp = (): App => {
  const revoked = new Set<string>();
  const sse = chatApp({
    context: (request) => request.headers.get("x-user") ?? undefined,
    key: (user) => user,
    authorize: ({ roomId }) => !revoked.has(roomId),
  });

  return {
    sse,
    revoke: (room) => {
      revoked.add(room);
    },
  };
};

/** One open Connection: the frames it is written, what `ready` said, and the way its client goes. */
interface Client {
  frames: Frames;
  refused: string[];
  cursor: Cursor;
  leave: () => void;
}

/**
 * Open a Connection on both rooms as `user`, resuming from `after` when there is one, and read
 * its opening sequence. The Key travels in a header this App's `context` reads, which is the
 * whole of what makes these Connections addressable by a Kick.
 */
async function connect(sse: ChatApp, user: string, after?: Cursor): Promise<Client> {
  const query = [KEPT, LOST].map((room) => `channel=chat:${room}`).join("&");
  const client = new AbortController();
  const headers: Record<string, string> = { "x-user": user };
  if (after !== undefined) headers["Last-Event-ID"] = after;

  const response = await sse.handlers.GET(
    new Request(`http://example.test/api/sse?${query}`, { signal: client.signal, headers }),
  );
  expect(response.status).toBe(200);

  const frames = framesOf(response);
  const ready = JSON.parse((await frames.next()).data ?? "{}") as {
    cursor: Cursor;
    refused: string[];
  };
  expect((await frames.next()).retry).toBe("3000");

  return {
    frames,
    refused: ready.refused,
    cursor: ready.cursor,
    leave: () => {
      client.abort();
    },
  };
}

/** One Message off the wire: the Channel it named and the text it carried, with its Cursor. */
async function nextMessage(client: Client): Promise<{ channel: string; text: string }> {
  const frame = await client.frames.next();
  if (frame.event !== undefined) throw new Error(`a Control event arrived: ${frame.event}`);
  const { channel, payload } = JSON.parse(frame.data ?? "{}") as {
    channel: string;
    payload: { text: string };
  };
  client.cursor = frame.id ?? client.cursor;

  return { channel, text: payload.text };
}

const say = (sse: ChatApp, room: string, text: string): Promise<Cursor> =>
  sse.chat({ roomId: room }).message({ text });

test("a kicked Connection comes back with its Cursor: what it keeps is gap-free, what it lost is refused", async () => {
  const { sse, revoke } = anApp();
  const first = await connect(sse, "ada");
  expect(first.refused).toEqual([]);
  expect((await first.frames.next()).event).toBe("caught-up");

  await say(sse, KEPT, "before the kick");
  await say(sse, LOST, "the last it saw");
  expect(await nextMessage(first)).toEqual({ channel: `chat:${KEPT}`, text: "before the kick" });
  expect(await nextMessage(first)).toEqual({ channel: `chat:${LOST}`, text: "the last it saw" });

  /** The App changes its mind, and the Kick is what makes the open Connection find out. */
  revoke(LOST);
  await sse.kick({ key: "ada" });

  expect((await first.frames.next()).event).toBe("reconnect");
  await expect(first.frames.next()).rejects.toThrow(/stream ended/);

  /** Published while the client is between two Connections: the window a Cursor exists for. */
  await say(sse, KEPT, "while it was away");

  const second = await connect(sse, "ada", first.cursor);

  expect(second.refused).toEqual([`chat:${LOST}`]);
  expect(await nextMessage(second)).toEqual({ channel: `chat:${KEPT}`, text: "while it was away" });
  expect((await second.frames.next()).event).toBe("caught-up");

  /**
   * The Connection is still open, which is the whole of "a Kick is not replayed": its replay
   * walked straight over the control Entry that ended the first one, and it goes on live.
   */
  await say(sse, KEPT, "and on it goes");
  await say(sse, LOST, "which it no longer reads");
  expect(await nextMessage(second)).toEqual({ channel: `chat:${KEPT}`, text: "and on it goes" });

  second.leave();
});

/**
 * The other way a Kick is addressed: a bound Handle, which is every Connection subscribed to
 * that Channel — whatever else those Connections carry, and whoever holds them.
 */
test("a Kick of a Handle ends the Connections on that Channel, and leaves the others alone", async () => {
  const { sse } = anApp();
  const subscribed = await connect(sse, "ada");
  expect((await subscribed.frames.next()).event).toBe("caught-up");

  await sse.kick(sse.chat({ roomId: KEPT }));

  expect((await subscribed.frames.next()).event).toBe("reconnect");

  /** It comes back to everything it had: nothing about a Kick decides what Authorize does. */
  const again = await connect(sse, "ada", subscribed.cursor);
  expect(again.refused).toEqual([]);
  expect((await again.frames.next()).event).toBe("caught-up");

  again.leave();
});

/**
 * A Kick names Connections, and a Connection nobody named carries on: the Key is the whole of
 * what the library knows about who holds one, and it is matched exactly.
 */
test("a Kick by Key leaves the Connections of every other Key untouched", async () => {
  const { sse } = anApp();
  const hers = await connect(sse, "ada");
  const his = await connect(sse, "sam");
  expect((await hers.frames.next()).event).toBe("caught-up");
  expect((await his.frames.next()).event).toBe("caught-up");

  await sse.kick({ key: "ada" });
  expect((await hers.frames.next()).event).toBe("reconnect");

  await say(sse, KEPT, "his Connection is untouched");
  expect(await nextMessage(his)).toEqual({
    channel: `chat:${KEPT}`,
    text: "his Connection is untouched",
  });

  his.leave();
});
