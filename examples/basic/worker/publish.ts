import { createPublisher } from "@flefebvre/next-sse/transport";
import { createRedisPublisher } from "@flefebvre/next-sse/transport/redis";

import type { sse as app } from "../lib/sse";

/**
 * A process outside Next.js Publishing into this App: the cron runner, the queue consumer, the
 * incident bot — anything that has something to say and is not a request.
 *
 * Run it against the same server the App runs on:
 *
 * ```sh
 * REDIS_URL=redis://127.0.0.1:6379 pnpm exec tsx examples/basic/worker/publish.ts "we shipped"
 * ```
 *
 * Two things make it typed without making it heavy. The App's Registry comes in as a **type**
 * — `import type` is erased before Node ever sees the specifier, so this process loads none of
 * the App's Authorize, session or database code, and none of Next.js — and `createPublisher`
 * puts that type over a Publisher, which is the write-only half of the Transport: Publish and
 * the tail, no live feed and no replay. The Channel name is then checked against the App's
 * patterns, the event against what that Channel declares, and the payload against the schema's
 * Output.
 *
 * Nothing validates here, and that is the honest reading of the type: no Registry is present at
 * runtime, so what this process writes is what a subscriber will receive. The Prefix is the
 * whole of the addressing — set the same `NEXT_SSE_PREFIX` the App runs under, or neither will
 * be talking to the other's log.
 *
 * What it does *not* do is write the App's data, because it cannot reach the App's memory. A
 * real worker writes the same database the page reads and then Publishes, in that order; this
 * one Publishes alone, so its announcements are live on every open page and gone from the next
 * server render. That is a property of the demo's in-memory store, not of the Publish.
 */
async function main(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === "") {
    throw new Error("This worker needs REDIS_URL: the log it Publishes into is the App's.");
  }

  /**
   * The Prefix is deliberately not passed through: the factory reads `NEXT_SSE_PREFIX` itself,
   * with the rule the App applies — an unset *or empty* variable is no Prefix at all, and the
   * default stands. Forwarding the variable would hand the factory `""` on a host that
   * materialises unset variables as empty strings, and an empty Prefix is refused rather than
   * defaulted, so a worker that read its environment by hand would fail where the App it
   * Publishes into runs happily.
   */
  const publisher = createRedisPublisher({ url });
  const sse = createPublisher<typeof app>(publisher);
  const text = process.argv[2] ?? "the worker was here";

  /**
   * The close is in a `finally` because a Publish can fail — an unreachable server, an
   * operation that timed out — and the connection it opened would otherwise hold this process
   * open long after the error was printed. A short-lived worker owes its Publisher a close on
   * every path out.
   */
  try {
    const cursor = await sse.publish("announcements", "posted", { id: crypto.randomUUID(), text });

    console.log(JSON.stringify({ published: text, cursor }));
  } finally {
    await publisher.close();
  }
}

/**
 * The App runs as CommonJS, as a Next.js app does unless it says otherwise, so the work sits in
 * a function rather than at the top level: a `.ts` file of this package cannot hold a top-level
 * `await`. A worker in a package of its own — `"type": "module"` — writes the same lines without
 * the wrapper.
 */
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
