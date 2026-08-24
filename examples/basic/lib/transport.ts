import type {
  Cursor,
  Entry,
  Page,
  Retention,
  StoredEntry,
  Transport,
} from "@flefebvre/next-sse/transport";
import { TransportClosedError } from "@flefebvre/next-sse/transport";

/**
 * A Transport of one's own, in as few lines as the contract allows: an ordered log in an array,
 * Cursors this log mints itself, and the two retention bounds every Transport owes.
 *
 * It is here to be read, not to be run: the App picks its Transport from the environment
 * (Redis when `REDIS_URL` is set, Memory when it is not), and wiring this one in would be a
 * branch the demo has no use for. What makes it worth shipping is the test beside it —
 * `transport.test.ts` runs the package's exported `transportContract` against it, which is the
 * same suite the Memory and Redis Transports are held to. A Transport nobody ran the contract
 * against is a claim, not a Transport.
 *
 * The five obligations a real backend has to honour, all of them visible below:
 *
 * - **Cursors are yours, and opaque to everybody else.** They are minted here, compared by
 *   equality above, and a Cursor from another log has to be recognised as foreign — hence the
 *   epoch. Nothing outside a Transport may parse one (ADR-0001).
 * - **`read` pages strictly after a Cursor**, and says whether the caller has caught up.
 * - **`gone` is honest.** A Cursor pointing into what retention dropped answers `gone` — never
 *   an arbitrary position — so the Connection above is told to refetch instead of silently
 *   missing Entries. Erring towards `gone` costs a Reset; the other direction loses Messages.
 * - **`subscribe` delivers what is published after it resolved**, and `onGap` fires when the
 *   position a subscription resumes from has been dropped. A log that cannot lose its reader's
 *   position — this one never disconnects from itself — never calls it.
 * - **The Entry is round-tripped, not held.** What comes back out is a copy, as it would be
 *   from a backend that stored JSON, so a caller that keeps mutating what it published cannot
 *   reach into the log.
 *
 * Anything else — a database, a queue, a file, a message bus — differs from this only in where
 * the array lives and in what it costs to reach it.
 */
export interface ArrayLogOptions {
  retention?: Retention;
}

/** ADR-0006's defaults, which every Transport shares: five minutes, ten thousand Entries. */
const DEFAULTS = { window: 300, cap: 10_000 };

/** One Entry as this log keeps it: what was published, and the moment it was. */
interface Kept {
  stored: StoredEntry;
  at: number;
}

export function createArrayLogTransport(options: ArrayLogOptions = {}): Transport {
  const keepFor = (options.retention?.window ?? DEFAULTS.window) * 1000;
  const keepAtMost = options.retention?.cap ?? DEFAULTS.cap;

  /**
   * The epoch is what makes a foreign Cursor recognisable: it is minted per log, so a Cursor
   * from another Transport, or from this App's previous run, is `gone` rather than a position
   * this log will happily read from.
   */
  const epoch = Math.random().toString(36).slice(2, 10);
  const kept: Kept[] = [];
  const feed = new Set<(stored: StoredEntry) => void>();

  let published = 0;
  let forgotten = 0;
  let open = true;

  const mint = (n: number): Cursor => `${epoch}.${String(n)}`;

  /** The number this log put in a Cursor, or `undefined` when the Cursor is not this log's. */
  const numberIn = (cursor: Cursor): number | undefined => {
    const dot = cursor.lastIndexOf(".");
    if (cursor.slice(0, dot) !== epoch) return undefined;

    const n = Number(cursor.slice(dot + 1));

    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };

  /** Everything retention no longer covers, gone: the oldest first, by age then by count. */
  const forget = (): void => {
    const expiry = Date.now() - keepFor;
    while (kept.length > 0) {
      const oldest = kept[0] as Kept;
      const expired = oldest.at <= expiry;
      if (!expired && kept.length <= keepAtMost) return;

      forgotten = published - kept.length + 1;
      kept.shift();
    }
  };

  const stillOpen = (): void => {
    if (!open) throw new TransportClosedError("This array log has been closed.");
  };

  return {
    async publish(entry: Entry): Promise<Cursor> {
      stillOpen();

      published += 1;
      const stored = { ...(JSON.parse(JSON.stringify(entry)) as Entry), cursor: mint(published) };
      kept.push({ stored, at: Date.now() });
      forget();

      for (const listener of feed) listener(stored);

      return stored.cursor;
    },

    async read(after: Cursor | undefined, limit: number): Promise<Page> {
      stillOpen();
      forget();

      /**
       * No Cursor is not a position: it is the caller asking for the log from wherever it now
       * begins, which is never `gone` however much has been dropped. A Cursor, in contrast, is
       * a claim about a position, and one below what retention kept is exactly what `gone` is
       * for.
       */
      const first = published - kept.length;
      const from = after === undefined ? first : numberIn(after);
      if (from === undefined || from > published || from < forgotten) return { gone: true };

      const start = Math.max(from - first, 0);
      const entries = kept.slice(start, start + Math.max(limit, 0)).map(({ stored }) => stored);

      return { entries, done: start + entries.length >= kept.length };
    },

    async tail(): Promise<Cursor> {
      stillOpen();

      return mint(published);
    },

    async subscribe(listener: (stored: StoredEntry) => void, { onGap }: { onGap: () => void }) {
      stillOpen();

      /**
       * A log that lives in the process reading it can never lose the position it resumes from,
       * so `onGap` is accepted and never called. A backend that reconnects — this one's Redis
       * counterpart — checks on every resume whether what it resumes from is still there, and
       * calls it exactly once when it is not.
       */
      void onGap;
      feed.add(listener);

      return () => {
        feed.delete(listener);
      };
    },

    async close(): Promise<void> {
      open = false;
      feed.clear();
      kept.length = 0;
    },
  };
}
