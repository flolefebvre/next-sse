import { INSTANCE_SLOT } from "../internal/instance-slot.js";
import type { Instance } from "../server/instance.js";
import type { Cursor } from "../transport/index.js";

/**
 * One Message as the log holds it: the Channel name as it is on the wire — params only exist
 * inside it — the event, and the payload the schema's Output made of what was published.
 */
export interface PublishedMessage {
  channel: string;
  event: string;
  payload: unknown;
}

/** The Instance's replay page size, restated so that no server code is imported for it. */
const PAGE_SIZE = 500;

/**
 * Start recording what this process Publishes, and get back the reader of what it recorded.
 *
 * The Instance is found through its process-wide slot, the one the App's `initSSE` builds it
 * into, so the App changes nothing for its tests; the `import type` above is erased, which
 * keeps the server graph — Next.js and React with it — out of this entry at runtime. The
 * recorder starts at the log's current position and the reader pages from there every time it
 * is called, so a recorder sees only what was published after it started: that position is the
 * isolation between two tests, and why nothing here resets anything.
 *
 * It reads whatever Transport the Instance has. Under `REDIS_URL` that is the Redis log, where
 * other processes' Publishes may land too.
 */
export async function recordPublishes(): Promise<() => Promise<PublishedMessage[]>> {
  const globals = globalThis as unknown as { [key: symbol]: Instance | undefined };
  const instance = globals[INSTANCE_SLOT];
  if (instance === undefined) {
    throw new Error(
      "next-sse: recordPublishes() found no Instance in this process. Import the module that " +
        "builds your Registry (the one calling initSSE) before calling recordPublishes(), " +
        "directly or through the code under test.",
    );
  }

  const { transport } = instance;
  const start = await transport.tail();

  return async () => {
    const published: PublishedMessage[] = [];
    let after: Cursor = start;
    for (;;) {
      const page = await transport.read(after, PAGE_SIZE);
      if ("gone" in page) {
        throw new Error(
          "next-sse: the log's retention dropped the position recordPublishes() started from, " +
            "so what was published since can no longer be read in full.",
        );
      }

      for (const entry of page.entries) {
        after = entry.cursor;
        if (entry.type === "message") {
          published.push({ channel: entry.channel, event: entry.event, payload: entry.payload });
        }
      }
      if (page.done) return published;
    }
  };
}
