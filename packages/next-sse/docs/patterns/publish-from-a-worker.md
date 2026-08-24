# Publishing from a worker

The publisher is not a request: a cron runner, a queue consumer, an incident bot, a service in
another language. Two ways in — typed, with the library, or the raw envelope, without it.

Example app:
[`worker/publish.ts`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/worker/publish.ts)
and
[`worker/raw-envelope.ts`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/worker/raw-envelope.ts).

Both need a shared log, which means Redis or Valkey: the Memory Transport lives inside one
process. Both address the App by its **Prefix** — set the same `NEXT_SSE_PREFIX` the App runs
under, or neither is talking to the other's log.

## Typed, with the library

```ts
// worker/publish.ts
import { createPublisher } from "@flefebvre/next-sse/transport";
import { createRedisPublisher } from "@flefebvre/next-sse/transport/redis";

import type { sse as app } from "../lib/sse";

async function main(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === "") {
    throw new Error("This worker needs REDIS_URL: the log it Publishes into is the App's.");
  }

  const publisher = createRedisPublisher({ url, prefix: process.env.NEXT_SSE_PREFIX });
  const sse = createPublisher<typeof app>(publisher);

  try {
    const cursor = await sse.publish("announcements", "posted", {
      id: crypto.randomUUID(),
      text: process.argv[2] ?? "the worker was here",
    });

    console.log(JSON.stringify({ cursor }));
  } finally {
    await publisher.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

Two things make it typed without making it heavy:

- **The Registry comes in as a type.** `import type` is erased before Node sees the specifier, so
  this process loads none of the App's Authorize, session or database code — and no Next.js and
  no React, which the package enforces for the transport entries.
- **`createPublisher<typeof app>` puts that type over a Publisher**, the write-only half of the
  Transport: publish and the tail, no live feed and no replay. So a worker holds exactly one
  connection.

The Channel **name** is checked against the App's patterns, the event against what that Channel
declares, and the payload against the schema's **Output**.

Nothing validates at runtime here — no Registry is present — which is the honest reading of the
type: what this process writes is what a subscriber receives.

Close the Publisher on every path out. A short-lived worker whose publish failed would otherwise
sit there with an open connection long after the error was printed.

## Raw, without the library

Any language, one `XADD` of one JSON envelope:

```ts
// worker/raw-envelope.ts
import { createClient } from "redis";

const prefix = process.env.NEXT_SSE_PREFIX ?? "next-sse";
const envelope = {
  v: 1,
  type: "message",
  channel: "announcements",
  event: "posted",
  payload: { id: crypto.randomUUID(), text: "written straight to the log" },
};

const client = createClient({ url: process.env.REDIS_URL });
client.on("error", (error: unknown) => {
  console.error(error);
});
await client.connect();

try {
  await client.sendCommand([
    "XADD",
    `{${prefix}}:log`,
    "MAXLEN",
    "~",
    "10000",
    "*",
    "entry",
    JSON.stringify(envelope),
  ]);
} finally {
  await client.close();
}
```

The key is `{<Prefix>}:log`, braces included; the single field is `entry`; the cap rides on the
write. The whole contract, including the control entry that Kicks, is in
[wire-format.md](../wire-format.md).

## Write the data, then publish

A worker that only Publishes moves what is on screen and nothing else: the Message is live on
every open page and gone from the next server render, because no server render will read it back.

A real worker writes the database the page reads **first**, then Publishes. That order is the same
one a server action follows, and for the same reason.

## Notes

- A worker publishing to a Channel nobody is subscribed to costs one log Entry and delivers
  nothing. That is normal and cheap.
- A worker cannot Authorize anything and does not need to: Authorize guards reading.
- To Kick from a worker, write the control entry directly ([wire-format.md](../wire-format.md)) —
  `createPublisher` covers Messages only.
- Run it against the App's server and Prefix:

  ```sh
  REDIS_URL=redis://127.0.0.1:6379 NEXT_SSE_PREFIX=my-app pnpm exec tsx worker/publish.ts "hello"
  ```
