import { randomUUID } from "node:crypto";

import {
  TransportClosedError,
  type Cursor,
  type Entry,
  type Page,
  type StoredEntry,
  type Transport,
  type Unsubscribe,
} from "./index.js";

/**
 * How much of the log is kept. Not honoured yet: this build never trims, so `read` never
 * answers `gone` for an Entry that was published on this Transport. The option is on the
 * factory from the start because ADR-0008 fixes the signature, and the two bounds ADR-0006
 * describes (a count cap and a time window) apply to both Transports.
 */
export interface Retention {
  /** How long an Entry stays readable, in seconds. */
  window?: number;
  /** How many Entries the log keeps at most. */
  cap?: number;
}

export interface MemoryTransportOptions {
  retention?: Retention;
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
  void options.retention;

  const epoch = randomUUID().slice(0, 8);
  const log: StoredEntry[] = [];
  const listeners = new Set<(entry: StoredEntry) => void>();
  let closed = false;

  const cursorOf = (position: number): Cursor => `${epoch}-${String(position)}`;

  /**
   * Where a Cursor sits in the log, as an index into it, or `undefined` when this log has no
   * idea what it is. `<epoch>-0` is a position, not an Entry, so it reads from the start.
   */
  const positionOf = (cursor: Cursor): number | undefined => {
    const [cursorEpoch, position] = splitOnce(cursor, "-");
    if (cursorEpoch !== epoch || position === undefined || !/^\d+$/.test(position)) {
      return undefined;
    }

    const index = Number(position);

    return index <= log.length ? index : undefined;
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
      const published: StoredEntry = { ...envelope, cursor: cursorOf(log.length + 1) };
      log.push(published);

      for (const listener of listeners) listener(published);

      return published.cursor;
    },

    async read(after: Cursor | undefined, limit: number): Promise<Page> {
      assertOpen();

      const from = after === undefined ? 0 : positionOf(after);
      if (from === undefined) return { gone: true };

      const entries = log.slice(from, from + Math.max(limit, 0));

      return { entries, done: from + entries.length >= log.length };
    },

    async tail(): Promise<Cursor> {
      assertOpen();

      return cursorOf(log.length);
    },

    async subscribe(
      listener: (entry: StoredEntry) => void,
      options: { onGap: () => void },
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
