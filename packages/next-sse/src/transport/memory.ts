import { randomUUID } from "node:crypto";

import {
  TransportClosedError,
  type Cursor,
  type Entry,
  type Page,
  type Retention,
  type StoredEntry,
  type Transport,
  type Unsubscribe,
} from "./index.js";

/** How long an Entry stays readable, in seconds, unless the App says otherwise (ADR-0006). */
const DEFAULT_WINDOW_SECONDS = 300;

/** How many Entries the log keeps at most, unless the App says otherwise (ADR-0006). */
const DEFAULT_CAP = 10_000;

export interface MemoryTransportOptions {
  retention?: Retention;
}

/** One Entry as this log holds it: the envelope, its position, and when it was published. */
interface Held {
  entry: StoredEntry;
  position: number;
  publishedAt: number;
}

/**
 * The single-Instance Transport: one ordered in-process log, no backend at all.
 *
 * Cursors are `<epoch>-<n>`, where the epoch is minted per Transport, so a Cursor from another
 * Transport — or from a previous process — is unknown to this log and answers `gone` rather
 * than resuming somewhere arbitrary. `<epoch>-0` is the position before the first Entry, which
 * is what `tail()` answers while nothing was ever published (ADR-0004).
 */
export function createMemoryTransport(options: MemoryTransportOptions = {}): Transport {
  const windowMs = (options.retention?.window ?? DEFAULT_WINDOW_SECONDS) * 1000;
  const cap = options.retention?.cap ?? DEFAULT_CAP;

  const epoch = randomUUID().slice(0, 8);
  const log: Held[] = [];
  const listeners = new Set<(entry: StoredEntry) => void>();
  let minted = 0;
  /**
   * The highest position this log ever dropped, which is what makes `gone` exact (ADR-0006's
   * `max-deleted-entry-id` rule): a Cursor at or above it has lost nothing to trimming, and one
   * below it has. `0` is the position before the first Entry, which nothing can be below.
   */
  let dropped = 0;
  let closed = false;

  const cursorOf = (position: number): Cursor => `${epoch}-${String(position)}`;

  /**
   * Drop what retention no longer covers: everything past the cap, and everything older than
   * the window. Both bounds are applied before the log is served as well as after it is
   * appended to, so a log that went quiet still tells the truth about what it has kept.
   */
  const trim = (): void => {
    const oldest = Date.now() - windowMs;
    let drop = Math.max(log.length - cap, 0);
    while (drop < log.length && (log[drop] as Held).publishedAt <= oldest) drop += 1;
    if (drop === 0) return;

    dropped = (log[drop - 1] as Held).position;
    log.splice(0, drop);
  };

  /**
   * Where a Cursor sits in the log, as an index into it, or `undefined` when this log cannot
   * serve it: another Transport's epoch, no position at all, a position it never minted, or one
   * it has since dropped. `<epoch>-0` is a position, not an Entry, so it reads from the start.
   */
  const indexOf = (cursor: Cursor): number | undefined => {
    const [cursorEpoch, position] = splitOnce(cursor, "-");
    if (cursorEpoch !== epoch || position === undefined || !/^\d+$/.test(position)) {
      return undefined;
    }

    const at = Number(position);
    if (at > minted || at < dropped) return undefined;

    const first = log[0];

    return first === undefined ? 0 : at - first.position + 1;
  };

  const assertOpen = (): void => {
    if (closed) throw new TransportClosedError("This Memory Transport has been closed.");
  };

  return {
    async publish(entry: Entry): Promise<Cursor> {
      assertOpen();

      /**
       * The envelope is round-tripped through JSON, exactly as the Redis Transport round-trips
       * it: what a caller gets back from the log is what a backend would have given back, and a
       * caller that keeps mutating the object it published cannot reach into the log.
       */
      const envelope = JSON.parse(JSON.stringify(entry)) as Entry;
      minted += 1;
      const published: StoredEntry = { ...envelope, cursor: cursorOf(minted) };
      log.push({ entry: published, position: minted, publishedAt: Date.now() });
      trim();

      for (const listener of listeners) listener(published);

      return published.cursor;
    },

    async read(after: Cursor | undefined, limit: number): Promise<Page> {
      assertOpen();
      trim();

      const from = after === undefined ? 0 : indexOf(after);
      if (from === undefined) return { gone: true };

      const entries = log.slice(from, from + Math.max(limit, 0)).map((held) => held.entry);

      return { entries, done: from + entries.length >= log.length };
    },

    async tail(): Promise<Cursor> {
      assertOpen();

      return cursorOf(minted);
    },

    async subscribe(
      listener: (entry: StoredEntry) => void,
      options: { onGap: (resumeFrom: Cursor) => void },
    ): Promise<Unsubscribe> {
      assertOpen();
      void options.onGap;

      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    async close(): Promise<void> {
      closed = true;
      listeners.clear();
      log.length = 0;
    },
  };
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const at = value.indexOf(separator);
  if (at === -1) return [value, undefined];

  return [value.slice(0, at), value.slice(at + separator.length)];
}
