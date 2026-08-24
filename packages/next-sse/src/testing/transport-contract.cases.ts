import { expect } from "vitest";

import {
  TransportClosedError,
  TransportError,
  TransportUnavailableError,
  type Cursor,
  type Entry,
  type Page,
  type Retention,
  type StoredEntry,
  type Transport,
} from "../transport/index.js";
import type { ContractCase, ContractContext } from "./transport-contract.js";

/** One Message, as an App publishes it. */
const message = (text: string): Entry => ({
  v: 1,
  type: "message",
  channel: "chat:42",
  event: "message",
  payload: { text },
});

/** One control Entry, which the log carries exactly as it carries a Message. */
const kick = (): Entry => ({ v: 1, type: "control", control: "kick", key: "user-7" });

/** The Entries of a page, or a failure naming what the log answered instead. */
const entriesOf = (page: Page): StoredEntry[] => {
  if ("gone" in page) throw new Error("the log answered gone where it had lost nothing");

  return page.entries;
};

/** What the Messages of a page say, which is what a case about ordering compares. */
const textsOf = (entries: StoredEntry[]): unknown[] =>
  entries
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry.payload as { text: unknown }).text);

/**
 * The Cursor at a position in what a case published or read, refusing to fall back to
 * `undefined` — which `read` would take as "from the start" and quietly answer.
 */
const cursorAt = (cursors: readonly Cursor[], index: number): Cursor => {
  const cursor = cursors[index];
  if (cursor === undefined) throw new Error(`There is no Cursor at position ${String(index)}.`);

  return cursor;
};

/** How long a case waits for something it can observe before giving up on it. */
const OBSERVE_TIMEOUT_MS = 2000;

/**
 * How long a case waits for a subscription to heal itself across an outage: the Transport's own
 * reconnect is in play, and a blocking read may sit out its timeout first.
 */
const HEAL_TIMEOUT_MS = 15_000;

/**
 * Wait for something the Transport does, never for a duration: the condition is polled until it
 * holds or the bound runs out, and the failure names what never happened.
 */
const until = async (
  holds: () => boolean,
  description: string,
  timeoutMs = OBSERVE_TIMEOUT_MS,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * How long an operation is given to settle while the backend is away. Nothing is retried
 * (ADR-0005), so a Transport that has not answered by then is retrying behind the caller's back.
 */
const NO_RETRY_TIMEOUT_MS = 10_000;

/** The operation, or a failure naming it, when it has not settled within the no-retry bound. */
const promptly = async <T>(operation: Promise<T>, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} never settled while the backend was away.`)),
      NO_RETRY_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([operation, bound]);
  } finally {
    clearTimeout(timer);
  }
};

/** The whole log as it stands, however many Entries it holds. */
const readAll = async (transport: Transport, after?: Cursor): Promise<StoredEntry[]> =>
  entriesOf(await transport.read(after, 10_000));

/** What a subscription saw: the Entries it was fed, and the gaps it reported. */
interface Seen {
  entries: StoredEntry[];
  gaps: number;
}

/** Attach to the live feed, recording what it delivers. */
const watch = async (transport: Transport): Promise<{ seen: Seen; detach: () => void }> => {
  const seen: Seen = { entries: [], gaps: 0 };
  const detach = await transport.subscribe(
    (entry) => {
      seen.entries.push(entry);
    },
    {
      onGap: () => {
        seen.gaps += 1;
      },
    },
  );

  return { seen, detach };
};

/**
 * A Transport with a peer on its log and a listener already fed one Entry: what an outage case
 * needs in place before it cuts the Transport off, namely a subscription with a position to lose
 * and a second Instance that will go on publishing without it.
 */
const watchedWithPeer = async (
  context: ContractContext,
  retention?: Retention,
): Promise<{ transport: Transport; peer: Transport; seen: Seen }> => {
  const transport = await context.transport(retention);
  const peer = await context.peer(transport);
  const { seen } = await watch(transport);

  await peer.publish(message("before the outage"));
  await until(() => seen.entries.length === 1, "the feed delivered the peer's first Entry");

  return { transport, peer, seen };
};

/** Wait for one Entry, named by the Cursor it was published under, to reach the live feed. */
const delivered = async (seen: Seen, cursor: Cursor, description: string): Promise<void> =>
  until(() => seen.entries.some((entry) => entry.cursor === cursor), description, HEAL_TIMEOUT_MS);

/** How many Entries are published in one go while a case pushes a log past its cap. */
const TRIM_BATCH = 128;

/** How many such batches a case will publish before it declares that retention never bit. */
const TRIM_BATCHES = 16;

/** A log pushed past its cap: everything it was given, and what it kept. */
interface Trimmed {
  published: Cursor[];
  retained: StoredEntry[];
}

/**
 * Publish until the log has dropped Entries — at least `atLeast` of them, so a case can name
 * the boundary and the position just below it. Trimming may be approximate (the Redis `MAXLEN ~`
 * of ADR-0006 keeps whole nodes), so the case never assumes the cap is the exact length: it
 * publishes until the log is demonstrably shorter than what it was given.
 */
const publishUntilTrimmed = async (transport: Transport, atLeast = 2): Promise<Trimmed> => {
  const published: Cursor[] = [];

  for (let batch = 0; batch < TRIM_BATCHES; batch += 1) {
    for (let n = 0; n < TRIM_BATCH; n += 1) {
      published.push(await transport.publish(message(`entry ${String(published.length)}`)));
    }

    const retained = await readAll(transport);
    if (published.length - retained.length >= atLeast) return { published, retained };
  }

  throw new Error(
    `Retention never bounded the log: ${String(published.length)} Entries were published under the cap this case asked for, and the log still holds every one of them.`,
  );
};

/** The Cursors of a page, which is the only thing a Cursor may be compared by. */
const cursorsOf = (entries: StoredEntry[]): Cursor[] => entries.map((entry) => entry.cursor);

export const contractCases: readonly ContractCase[] = [
  {
    name: "publish returns the Cursor it minted, and the log hands that same Cursor back",
    run: async (context) => {
      const transport = await context.transport();

      const first = await transport.publish(message("one"));
      const second = await transport.publish(message("two"));

      expect(cursorsOf(await readAll(transport))).toEqual([first, second]);
    },
  },
  {
    name: "an Entry comes back out of the log as it was published, and is not the object published",
    run: async (context) => {
      const transport = await context.transport();
      const entry = message("one");

      const cursor = await transport.publish(entry);
      entry.channel = "chat:other";

      expect(await readAll(transport)).toEqual([{ ...message("one"), cursor }]);
    },
  },
  {
    name: "a control Entry travels through the log exactly as a Message does",
    run: async (context) => {
      const transport = await context.transport();

      const cursor = await transport.publish(kick());

      expect(await readAll(transport)).toEqual([{ ...kick(), cursor }]);
    },
  },
  {
    name: "every Cursor the log mints is a distinct, non-empty string",
    run: async (context) => {
      const transport = await context.transport();

      const minted = [
        await transport.publish(message("one")),
        await transport.publish(message("two")),
        await transport.publish(message("three")),
      ];

      for (const cursor of minted) {
        expect(typeof cursor).toBe("string");
        expect(cursor).not.toBe("");
      }
      expect(new Set(minted).size).toBe(minted.length);
    },
  },
  {
    name: "read pages strictly after a Cursor and reports whether the caller has caught up",
    run: async (context) => {
      const transport = await context.transport();
      const first = await transport.publish(message("one"));
      await transport.publish(message("two"));
      await transport.publish(message("three"));

      const page = await transport.read(first, 1);
      const entries = entriesOf(page);
      expect(textsOf(entries)).toEqual(["two"]);
      expect("done" in page && page.done).toBe(false);

      const rest = await transport.read(cursorAt(cursorsOf(entries), 0), 10);
      expect(textsOf(entriesOf(rest))).toEqual(["three"]);
      expect("done" in rest && rest.done).toBe(true);
    },
  },
  {
    name: "read without a Cursor answers the log from its start",
    run: async (context) => {
      const transport = await context.transport();
      await transport.publish(message("one"));
      await transport.publish(message("two"));

      expect(textsOf(await readAll(transport))).toEqual(["one", "two"]);
    },
  },
  {
    name: "read from the position of the last Entry answers no Entries, and done",
    run: async (context) => {
      const transport = await context.transport();
      const cursor = await transport.publish(message("one"));

      expect(await transport.read(cursor, 10)).toEqual({ entries: [], done: true });
    },
  },
  {
    name: "read answers gone for a Cursor no log could have minted, and never throws",
    run: async (context) => {
      const transport = await context.transport();
      await transport.publish(message("one"));

      expect(await transport.read("", 10)).toEqual({ gone: true });
      expect(await transport.read("not-a-cursor", 10)).toEqual({ gone: true });
    },
  },
  {
    name: "tail answers a Cursor on an empty log, and that Cursor reads from the start",
    run: async (context) => {
      const transport = await context.transport();

      const beforeAnything = await transport.tail();
      expect(typeof beforeAnything).toBe("string");
      expect(beforeAnything).not.toBe("");

      await transport.publish(message("one"));

      expect(textsOf(await readAll(transport, beforeAnything))).toEqual(["one"]);
    },
  },
  {
    name: "tail reads the current position without writing anything",
    run: async (context) => {
      const transport = await context.transport();
      const cursor = await transport.publish(message("one"));

      expect(await transport.tail()).toBe(cursor);
      expect(await transport.tail()).toBe(cursor);
      expect(textsOf(await readAll(transport))).toEqual(["one"]);
    },
  },
  {
    name: "subscribe delivers every Entry published after it resolved, this Instance's own included",
    run: async (context) => {
      const transport = await context.transport();
      const { seen } = await watch(transport);

      const cursor = await transport.publish(message("after"));
      const kicked = await transport.publish(kick());

      await until(() => seen.entries.length === 2, "the live feed delivered both Entries");
      expect(seen.entries).toEqual([
        { ...message("after"), cursor },
        { ...kick(), cursor: kicked },
      ]);
    },
  },
  {
    name: "an Entry published before the subscription resolved is not delivered to it",
    run: async (context) => {
      const transport = await context.transport();
      await transport.publish(message("before"));

      const { seen } = await watch(transport);
      await transport.publish(message("after"));

      await until(() => seen.entries.length >= 1, "the live feed delivered the later Entry");
      expect(textsOf(seen.entries)).toEqual(["after"]);
    },
  },
  {
    name: "several listeners attach to the one log, and unsubscribing detaches only its own",
    run: async (context) => {
      const transport = await context.transport();
      const one = await watch(transport);
      const two = await watch(transport);

      await transport.publish(message("one"));
      await until(
        () => one.seen.entries.length === 1 && two.seen.entries.length === 1,
        "both listeners were fed the first Entry",
      );

      one.detach();
      await transport.publish(message("two"));

      await until(() => two.seen.entries.length === 2, "the attached listener was fed the second");
      expect(textsOf(one.seen.entries)).toEqual(["one"]);
    },
  },
  {
    name: "the cap bounds the log, and a Cursor into what it dropped is gone",
    run: async (context) => {
      const transport = await context.transport({ cap: 2 });

      const { published, retained } = await publishUntilTrimmed(transport);

      expect(cursorsOf(retained)).toEqual(published.slice(published.length - retained.length));
      expect(await transport.read(cursorAt(published, 0), retained.length)).toEqual({ gone: true });
    },
  },
  {
    /**
     * `gone` is bounded on both sides, one Entry apart: what the log still holds must read, and
     * what it dropped must not. The Cursor of the newest dropped Entry — the one position where
     * "gone" and "kept" meet — is deliberately left unspecified: a log may answer either there.
     *
     * The Memory Transport is exact at that boundary, and the Redis Transport cannot be: Redis
     * maintains `max-deleted-entry-id` for `XDEL` alone, so a trimmed log's own record of what
     * it lost is the oldest Entry it kept, and a Cursor one below that is indistinguishable from
     * one long dropped. Answering `gone` there costs a Connection one Reset; the reverse — a log
     * claiming a Cursor is good when Entries after it are gone — would cost silent loss, and
     * that direction is what this case pins.
     */
    name: "gone is honest: the oldest retained Entry reads, and what was dropped is gone",
    run: async (context) => {
      const transport = await context.transport({ cap: 2 });

      const { published, retained } = await publishUntilTrimmed(transport);
      const oldestKept = published.length - retained.length;

      const page = await transport.read(cursorAt(published, oldestKept), retained.length);
      expect(cursorsOf(entriesOf(page))).toEqual(cursorsOf(retained).slice(1));
      expect("done" in page && page.done).toBe(true);
      expect(await transport.read(cursorAt(published, oldestKept - 2), retained.length)).toEqual({
        gone: true,
      });
    },
  },
  {
    name: "a subscription that never missed an Entry reports no gap, however much the log trims",
    run: async (context) => {
      const transport = await context.transport({ cap: 2 });
      const { seen } = await watch(transport);

      const { published } = await publishUntilTrimmed(transport);

      await until(
        () =>
          seen.entries.some((entry) => entry.cursor === cursorAt(published, published.length - 1)),
        "the live feed delivered the last Entry published",
      );
      expect(seen.gaps).toBe(0);
    },
  },
  {
    name: "a closed Transport answers nothing further, and closing twice is not an error",
    run: async (context) => {
      const transport = await context.transport();
      await transport.publish(message("one"));

      await transport.close();
      await transport.close();

      const closed = { onGap: () => undefined };
      await expect(transport.publish(message("two"))).rejects.toBeInstanceOf(TransportClosedError);
      await expect(transport.read(undefined, 10)).rejects.toBeInstanceOf(TransportClosedError);
      await expect(transport.tail()).rejects.toBeInstanceOf(TransportClosedError);
      await expect(transport.subscribe(() => undefined, closed)).rejects.toBeInstanceOf(
        TransportClosedError,
      );
    },
  },
  {
    name: "the failures a Transport reports are one family, catchable in one clause",
    run: async (context) => {
      const transport = await context.transport();
      await transport.close();

      await expect(transport.tail()).rejects.toBeInstanceOf(TransportError);
    },
  },
  {
    name: "while the backend is away, operations reject with TransportUnavailableError, unretried",
    needs: ["outage"],
    run: async (context) => {
      const transport = await context.transport();
      await transport.publish(message("before"));

      await context.outage.begin(transport);

      await expect(
        promptly(transport.publish(message("during")), "publish"),
      ).rejects.toBeInstanceOf(TransportUnavailableError);
      await expect(promptly(transport.read(undefined, 10), "read")).rejects.toBeInstanceOf(
        TransportUnavailableError,
      );
      await expect(promptly(transport.tail(), "tail")).rejects.toBeInstanceOf(
        TransportUnavailableError,
      );

      await context.outage.end(transport);

      const cursor = await transport.publish(message("after"));
      expect(cursorsOf(await readAll(transport))).toContain(cursor);
    },
  },
  {
    name: "the subscription heals across an outage and delivers what it missed, reporting no gap",
    needs: ["outage", "peer"],
    run: async (context) => {
      const { transport, peer, seen } = await watchedWithPeer(context);

      await context.outage.begin(transport);
      const during = await peer.publish(message("during the outage"));
      await context.outage.end(transport);

      await delivered(seen, during, "the feed delivered what was published during the outage");
      expect(seen.gaps).toBe(0);
    },
  },
  {
    name: "the subscription reports one gap when the position it resumes from is gone, then resumes",
    needs: ["outage", "peer"],
    run: async (context) => {
      const { transport, peer, seen } = await watchedWithPeer(context, { cap: 2 });

      await context.outage.begin(transport);
      await publishUntilTrimmed(peer);
      await context.outage.end(transport);

      await until(() => seen.gaps === 1, "the subscription reported the gap", HEAL_TIMEOUT_MS);

      const after = await transport.publish(message("after the gap"));
      await delivered(seen, after, "the feed resumed once the gap had been reported");
      expect(seen.gaps).toBe(1);
    },
  },
  {
    name: "a peer's Publish reaches this Instance's subscription, in order with its own",
    needs: ["peer"],
    run: async (context) => {
      const transport = await context.transport();
      const peer = await context.peer(transport);
      const { seen } = await watch(transport);

      const mine = await transport.publish(message("mine"));
      const theirs = await peer.publish(message("theirs"));

      await until(() => seen.entries.length === 2, "the feed delivered both Publishes");
      expect(cursorsOf(seen.entries)).toEqual([mine, theirs]);
    },
  },
  {
    name: "read pages after a Cursor a peer minted, as after one of this Instance's own",
    needs: ["peer"],
    run: async (context) => {
      const transport = await context.transport();
      const peer = await context.peer(transport);

      const theirs = await peer.publish(message("theirs"));
      const mine = await transport.publish(message("mine"));

      expect(cursorsOf(entriesOf(await transport.read(theirs, 10)))).toEqual([mine]);
    },
  },
] as const;
