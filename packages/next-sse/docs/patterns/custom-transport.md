# Custom transport

The log does not have to be Redis. A Transport is five methods over anything ordered — a database
table, a queue, a message bus, an array.

Example app:
[`lib/transport.ts`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/lib/transport.ts),
held to the contract in
[`lib/transport.test.ts`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/lib/transport.test.ts).

## The interface

```ts
import type {
  Cursor,
  Entry,
  Page,
  Retention,
  StoredEntry,
  Transport,
  Unsubscribe,
} from "@flefebvre/next-sse/transport";
```

```ts
interface Transport {
  publish(entry: Entry): Promise<Cursor>;
  read(after: Cursor | undefined, limit: number): Promise<Page>;
  tail(): Promise<Cursor>;
  subscribe(
    listener: (entry: StoredEntry) => void,
    options: { onGap: (resumeFrom: Cursor) => void },
  ): Promise<Unsubscribe>;
  close(): Promise<void>;
}
```

Nothing here is Channel-, Authorize- or Connection-aware. Routing, replay and the exactly-once cut
live in the Instance, written once for every Transport.

## A log in an array

The whole shape, in as few lines as the contract allows:

```ts
// lib/transport.ts
import {
  TransportClosedError,
  type Cursor,
  type Entry,
  type Page,
  type Retention,
  type StoredEntry,
  type Transport,
} from "@flefebvre/next-sse/transport";

const DEFAULTS = { window: 300, cap: 10_000 };

interface Kept {
  stored: StoredEntry;
  at: number;
}

export function createArrayLogTransport(options: { retention?: Retention } = {}): Transport {
  const keepFor = (options.retention?.window ?? DEFAULTS.window) * 1000;
  const keepAtMost = options.retention?.cap ?? DEFAULTS.cap;

  // Minted per log, so a Cursor from another Transport — or from this App's previous run — is
  // recognisably foreign and answers `gone` rather than resuming somewhere arbitrary.
  const epoch = Math.random().toString(36).slice(2, 10);
  const kept: Kept[] = [];
  const feed = new Set<(stored: StoredEntry) => void>();

  let published = 0;
  let forgotten = 0;
  let open = true;

  const mint = (n: number): Cursor => `${epoch}.${String(n)}`;

  const numberIn = (cursor: Cursor): number | undefined => {
    const dot = cursor.lastIndexOf(".");
    if (cursor.slice(0, dot) !== epoch) return undefined;
    const n = Number(cursor.slice(dot + 1));

    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };

  const forget = (): void => {
    const expiry = Date.now() - keepFor;
    while (kept.length > 0) {
      const oldest = kept[0] as Kept;
      if (oldest.at > expiry && kept.length <= keepAtMost) return;
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

      // No Cursor is not a position: it is the caller asking for the log from wherever it now
      // begins, which is never `gone`. A Cursor is a claim about a position, and one below what
      // retention kept is exactly what `gone` is for.
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

    async subscribe(listener, { onGap }) {
      stillOpen();

      // A log that lives in the process reading it can never lose the position it resumes from,
      // so `onGap` is accepted and never called. A backend that reconnects checks on every resume
      // whether what it resumes from is still there, and calls it exactly once when it is not.
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
```

## Prove it with the contract suite

```ts
// lib/transport.test.ts
import { transportContract } from "@flefebvre/next-sse/testing";

import { createArrayLogTransport } from "./transport";

transportContract({
  create: ({ retention }) => createArrayLogTransport({ retention }),
});
```

That is the same suite the Memory and Redis Transports are held to. **A Transport nobody ran the
contract against is a claim, not a Transport.**

`create` must answer an empty log honouring the Retention it is given: a case assumes the only
Entries it will read are the ones it published. A factory sharing one backend isolates each call —
a fresh Prefix, a fresh table.

Two optional hooks unlock the cases no log can stage on its own — `peer` (a second Transport on
the same log) and `outage` (cut **one** Transport off from the backend and let it back in). Cases
needing a hook you did not supply are reported as skipped, by name, rather than passing quietly.

## The five obligations, in words

1. **Cursors are yours, and opaque to everybody else.** Everything above compares them by equality
   only. A foreign Cursor must be recognised.
2. **`read` pages strictly after a Cursor**, with an honest `done`.
3. **`gone` is honest.** A Cursor pointing into what retention dropped answers `gone` — never an
   arbitrary position. Erring toward `gone` costs a Reset; erring the other way loses Messages
   silently.
4. **`subscribe` delivers what is published after it resolved**, and `onGap` fires exactly once,
   with a position `read` will serve.
5. **The Entry is round-tripped, not held** — a copy out, as from a backend that stored JSON.

Plus the error taxonomy: `TransportUnavailableError` when the backend is away or too slow,
`TransportClosedError` after `close()`, both extending `TransportError`. Nothing is retried by a
Transport; every operation settles within its own bound.

## Wire it in

```ts
import { initSSE } from "@flefebvre/next-sse/server";

import { createArrayLogTransport } from "./transport";

const { channel, createSSE } = initSSE({ transport: createArrayLogTransport() });
```

Explicit configuration wins over the environment, so an App that passes a Transport gets it
whatever `REDIS_URL` says.

## Notes

- Transports are plain objects from factories, connected lazily. The Instance calls `subscribe`
  once and `close` on Drain.
- The feed must include the Instance's own Publishes: one ordering, no local short-circuit.
- The full reference, including the shipped Transports' options, is
  [transport.md](../transport.md).
