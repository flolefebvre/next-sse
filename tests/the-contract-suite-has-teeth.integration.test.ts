import { expect, test } from "vitest";

import {
  contractCases,
  runContractCase,
  type TransportBackend,
  type TransportContractOptions,
} from "../packages/next-sse/src/testing/transport-contract.js";
import {
  TransportClosedError,
  TransportUnavailableError,
  type Cursor,
  type Entry,
  type Page,
  type Retention,
  type StoredEntry,
  type Transport,
  type Unsubscribe,
} from "../packages/next-sse/src/transport/index.js";

/**
 * What proves the suite is worth running: a toy log that keeps the whole ADR-0005 obligation
 * passes every case, including the ones the Memory Transport can only skip, and a toy that
 * breaks one rule is caught by the case that names that rule. The cases are run directly, in
 * this process, so no second Vitest run is needed to watch a suite fail.
 *
 * The toy lives here and is never shipped: it is a fixture for the suite, not a Transport.
 */

/** The one rule a toy is told to break. */
type Flaw =
  | "wrong-cursor"
  | "shared-entry"
  | "inclusive-read"
  | "always-done"
  | "silent-replay"
  | "over-eager-gone"
  | "skip-own-publishes"
  | "late-subscribe"
  | "open-after-close"
  | "retrying-publish";

/** The log itself, which several toy Transports may share the way Instances share a backend. */
interface ToyLog {
  entries: StoredEntry[];
  /** How many positions the log has ever handed out; the last of them is what `tail` answers. */
  minted: number;
  /** The highest position ever dropped, which is what makes `gone` exact (ADR-0006). */
  dropped: number;
  cap: number;
}

/** One listener on a toy Transport, with the position it would resume from. */
interface ToyReader {
  listener: (entry: StoredEntry) => void;
  onGap: (resumeFrom: Cursor) => void;
  lastSeen: Cursor;
}

/** One toy Transport's own state: its log, its readers, and whether it can reach the backend. */
interface ToyState {
  log: ToyLog;
  readers: Set<ToyReader>;
  offline: boolean;
  closed: boolean;
  flaw?: Flaw;
}

const states = new Map<Transport, ToyState>();

const stateOf = (transport: Transport): ToyState => {
  const state = states.get(transport);
  if (state === undefined) throw new Error("That Transport was not made by this fixture.");

  return state;
};

const cursorOf = (position: number): Cursor => `toy-${String(position)}`;

/** The position a Cursor names, or `undefined` when this log cannot make sense of it. */
const positionOf = (cursor: Cursor): number | undefined =>
  /^toy-\d+$/.test(cursor) ? Number(cursor.slice("toy-".length)) : undefined;

/** Everyone attached to one log, which is how a Publish reaches the other Instances. */
const readersOn = (log: ToyLog): ToyState[] =>
  [...states.values()].filter((state) => state.log === log && !state.closed);

/** Feed a reader everything the log holds after its position, or tell it the position is gone. */
const catchUp = (state: ToyState): void => {
  for (const reader of state.readers) {
    const position = positionOf(reader.lastSeen);
    if (position === undefined || position < state.log.dropped) {
      reader.lastSeen = cursorOf(state.log.minted);
      reader.onGap(reader.lastSeen);
      continue;
    }

    for (const entry of state.log.entries.slice(position - state.log.dropped)) {
      reader.lastSeen = entry.cursor;
      reader.listener(entry);
    }
  }
};

const createToyTransport = (log: ToyLog, flaw?: Flaw): Transport => {
  const state: ToyState = { log, readers: new Set(), offline: false, closed: false, flaw };

  const reachable = async (): Promise<void> => {
    if (state.closed) throw new TransportClosedError("This toy Transport has been closed.");
    if (!state.offline) return;
    if (flaw !== "retrying-publish") {
      throw new TransportUnavailableError("This toy Transport cannot reach its log.");
    }

    while (state.offline) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  const transport: Transport = {
    async publish(entry: Entry): Promise<Cursor> {
      await reachable();

      log.minted += 1;
      const cursor = cursorOf(log.minted);
      const stored =
        flaw === "shared-entry"
          ? Object.assign(entry, { cursor })
          : { ...(JSON.parse(JSON.stringify(entry)) as Entry), cursor };
      log.entries.push(stored);

      while (log.entries.length > log.cap) {
        log.entries.shift();
        log.dropped += 1;
      }

      for (const other of readersOn(log)) {
        if (other.offline) continue;
        if (flaw === "skip-own-publishes" && other === state) continue;

        for (const reader of other.readers) {
          reader.lastSeen = cursor;
          reader.listener(stored);
        }
      }

      return flaw === "wrong-cursor" ? cursorOf(0) : cursor;
    },

    async read(after: Cursor | undefined, limit: number): Promise<Page> {
      await reachable();

      const position = after === undefined ? log.dropped : positionOf(after);
      const lost =
        position === undefined ||
        position > log.minted ||
        (flaw === "over-eager-gone" ? position <= log.dropped + 1 : position < log.dropped);

      if (lost && flaw !== "silent-replay") return { gone: true };

      const from = lost || position === undefined ? 0 : position - log.dropped;
      const at = flaw === "inclusive-read" ? Math.max(from - 1, 0) : from;
      const entries = log.entries.slice(at, at + limit);

      return {
        entries,
        done: flaw === "always-done" ? true : at + entries.length >= log.entries.length,
      };
    },

    async tail(): Promise<Cursor> {
      await reachable();

      return cursorOf(log.minted);
    },

    async subscribe(
      listener: (entry: StoredEntry) => void,
      options: { onGap: (resumeFrom: Cursor) => void },
    ): Promise<Unsubscribe> {
      await reachable();

      const reader: ToyReader = { listener, onGap: options.onGap, lastSeen: cursorOf(log.minted) };
      if (flaw === "late-subscribe") setTimeout(() => state.readers.add(reader), 20);
      else state.readers.add(reader);

      return () => state.readers.delete(reader);
    },

    async close(): Promise<void> {
      if (flaw === "open-after-close") return;

      state.closed = true;
      state.readers.clear();
    },
  };

  states.set(transport, state);

  return transport;
};

/** The options a toy is run under: its factory, and the backend hooks only a fixture can offer. */
const toyOptions = (flaw?: Flaw): TransportContractOptions => {
  const backend: TransportBackend = {
    outage: {
      begin: async (transport) => {
        stateOf(transport).offline = true;
      },
      end: async (transport) => {
        const state = stateOf(transport);
        state.offline = false;
        catchUp(state);
      },
    },
    peer: (transport) => createToyTransport(stateOf(transport).log, stateOf(transport).flaw),
  };

  return {
    create: ({ retention }: { retention: Retention }) =>
      createToyTransport(
        { entries: [], minted: 0, dropped: 0, cap: retention.cap ?? 10_000 },
        flaw,
      ),
    backend,
  };
};

/** Every case run against one toy, and the names of those it failed. */
const casesFailedBy = async (flaw?: Flaw): Promise<string[]> => {
  const failed: string[] = [];

  for (const contractCase of contractCases) {
    try {
      await runContractCase(contractCase, toyOptions(flaw));
    } catch {
      failed.push(contractCase.name);
    }
  }

  return failed;
};

/** What one named case did to a toy: the failure it raised, or nothing when the toy got away. */
const failureOf = async (flaw: Flaw, name: string): Promise<unknown> => {
  const contractCase = contractCases.find((candidate) => candidate.name === name);
  if (contractCase === undefined) throw new Error(`No contract case is named "${name}".`);

  try {
    await runContractCase(contractCase, toyOptions(flaw));
  } catch (error) {
    return error;
  }

  return undefined;
};

/**
 * The gated cases are the ones no shipped Transport can run yet — the Memory Transport has no
 * outage to stage and no second Instance — so this is where they are proven to work at all,
 * before the Redis Transport supplies the hooks.
 */
test("a Transport that keeps the whole obligation passes every case, capabilities included", async () => {
  expect(await casesFailedBy()).toEqual([]);
  expect(contractCases.filter((contractCase) => contractCase.needs !== undefined)).not.toEqual([]);
}, 120_000);

/** One broken rule, and the case whose name says that rule is the one that must catch it. */
const BROKEN: ReadonlyArray<[Flaw, string]> = [
  ["wrong-cursor", "publish returns the Cursor it minted, and the log hands that same Cursor back"],
  [
    "shared-entry",
    "an Entry comes back out of the log as it was published, and is not the object published",
  ],
  [
    "inclusive-read",
    "read pages strictly after a Cursor and reports whether the caller has caught up",
  ],
  [
    "always-done",
    "read pages strictly after a Cursor and reports whether the caller has caught up",
  ],
  ["silent-replay", "the cap bounds the log, and a Cursor into what it dropped is gone"],
  [
    "over-eager-gone",
    "gone is honest: the oldest retained Entry reads, and what was dropped is gone",
  ],
  [
    "skip-own-publishes",
    "subscribe delivers every Entry published after it resolved, this Instance's own included",
  ],
  [
    "late-subscribe",
    "subscribe delivers every Entry published after it resolved, this Instance's own included",
  ],
  [
    "open-after-close",
    "a closed Transport answers nothing further, and closing twice is not an error",
  ],
  [
    "retrying-publish",
    "while the backend is away, operations reject with TransportUnavailableError, unretried",
  ],
];

for (const [flaw, caught] of BROKEN) {
  test(`a Transport that breaks ${flaw} fails the case that names it`, async () => {
    expect(await failureOf(flaw, caught)).toBeInstanceOf(Error);
  }, 120_000);
}
