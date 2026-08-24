import { expect, test } from "vitest";

import { DEMO_ROOM, nextMessage, openRoomsStream, publish } from "./harness/demo.js";
import { twoInstances, type TwoInstances } from "./harness/example.js";
import type { Stream } from "./harness/stream.js";

/**
 * The volume run: a few thousand Messages, Published on both Instances into two rooms, read by
 * one Connection that is cut and resumed halfway through — and every Message arrives exactly
 * once, in order, on the Channel it was Published to.
 *
 * The other scenarios each prove one claim on a handful of Messages. This one is here because
 * off-by-one is a matter of scale: a replay window that repeats its first entry, a page boundary
 * that drops one, a live feed that overlaps the replay it took over from — none of them show on
 * three Messages, and all of them show on two thousand with a reconnect in the middle. It runs
 * on every push rather than nightly (ADR-0009): a gap-free library that only checks for gaps
 * once a day is not one.
 *
 * Two rooms, because "exactly once per Channel" means nothing on one: the two are interleaved
 * in a single log, under a single Cursor, and each has to come out whole and in order.
 */

/** The rooms this run interleaves. Two, which is what the alternation below assumes. */
const ROOMS = [DEMO_ROOM, "7"];
const MESSAGES = 2000;
/** Where the Connection is cut: mid-run, with the Publishing going on across the gap. */
const RECONNECT_AFTER = MESSAGES / 2;
/** How long one Message may keep the reader waiting while a run of this size is in flight. */
const PATIENCE_MS = 30_000;

/** One Connection, held by whichever Instance the reader is on at the time. */
interface Reader {
  stream: Stream;
}

test(
  "a few thousand Messages across two Instances arrive exactly once per Channel",
  { timeout: 300_000 },
  async () => {
    const app = await twoInstances();
    const reader: Reader = { stream: openRoomsStream(app.here.url, ROOMS) };

    try {
      await reader.stream.next("ready");
      await reader.stream.next("caught-up");

      /**
       * Read and Publish at once, which is the only honest shape for this: a reader that started
       * after the last Publish would be testing replay alone, and one that never fell behind would
       * be testing the live feed alone. Both halves are awaited together, so a webhook that
       * refuses ends the run there rather than as a reader timing out for no stated reason.
       */
      const [received] = await Promise.all([readEverything(app, reader), publishEverything(app)]);

      for (const [at, room] of ROOMS.entries()) {
        expect(received.get(room)).toEqual(published(room, at));
      }
    } finally {
      reader.stream.close();
      await app.stop();
    }
  },
);

/**
 * Publish every Message, alternating rooms every one and Instances every two, so that neither
 * the Channels nor the writers line up with each other. Sequential on purpose: what the reader
 * is checked against is the order they went into the log in, and that order is only knowable
 * because each Publish is answered before the next is made.
 */
async function publishEverything(app: TwoInstances): Promise<void> {
  for (let n = 0; n < MESSAGES; n += 1) {
    const room = ROOMS[n % ROOMS.length] as string;
    const instance = n % 4 < 2 ? app.here : app.there;
    await publish(instance.url, `${room}-${String(n)}`, room);
  }
}

/**
 * Read every Message, cutting the Connection halfway and coming back on the other Instance with
 * the position the last one carried — the mid-run reconnect, staged the way a client does it:
 * the Cursor comes from the protocol, and the Publishing never pauses for it.
 */
async function readEverything(app: TwoInstances, reader: Reader): Promise<Map<string, string[]>> {
  const received = new Map(ROOMS.map((room) => [room, [] as string[]]));
  let cursor = "";

  for (let read = 0; read < MESSAGES; read += 1) {
    if (read === RECONNECT_AFTER) {
      reader.stream.close();
      reader.stream = openRoomsStream(app.there.url, ROOMS, cursor);
      await reader.stream.next("ready");
    }

    const delivered = await nextMessage(reader.stream, PATIENCE_MS);
    cursor = delivered.cursor;
    const room = delivered.channel.replace("chat:", "");
    const texts = received.get(room);
    if (texts === undefined) {
      throw new Error(`a Message arrived on ${delivered.channel}, which nobody subscribed to`);
    }
    texts.push(delivered.text);
  }

  return received;
}

/** What one room was Published, in order: the alternation above gave it every other Message. */
const published = (room: string, at: number): string[] =>
  Array.from(
    { length: MESSAGES / ROOMS.length },
    (_, n) => `${room}-${String(n * ROOMS.length + at)}`,
  );
