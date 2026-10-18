import { createRequire } from "node:module";

import { createPublisher } from "@flefebvre/next-sse/transport";
import { createRedisPublisher } from "@flefebvre/next-sse/transport/redis";
import type { ChannelDeclaration, Registry, StandardSchemaV1 } from "@flefebvre/next-sse/server";

/**
 * A process outside Next.js, in a package that has Next.js nowhere in its dependencies: a cron
 * runner, a queue consumer, a data importer. It resolves `@flefebvre/next-sse` through the real
 * exports map against the built `dist`, exactly as an installed consumer does.
 *
 * The App is named the way this process should name it — as a type. A worker could import the
 * Registry itself since ADR-0012, but it should not: that would load the App's Authorize, session
 * and database code, and install the Drain's signal handlers in a process that holds no
 * Connection. `import type` of the `./server` entry is erased before the specifier ever reaches
 * Node, and running this file is what proves the typed path costs this process nothing of the
 * App. In a real project the line is `import type { sse } from "../app/lib/sse"`; it is spelled
 * out here because this fixture has no App beside it.
 */
interface Message {
  id: string;
  text: string;
}

type App = Registry<{
  chat: ChannelDeclaration<"chat:{roomId}", { message: StandardSchemaV1<Message> }>;
  announcements: ChannelDeclaration<"announcements", { posted: StandardSchemaV1<Message> }>;
}>;

const url = process.env.REDIS_URL;
const prefix = process.env.NEXT_SSE_PREFIX;
if (url === undefined || prefix === undefined) {
  throw new Error("worker-consumer needs REDIS_URL and NEXT_SSE_PREFIX.");
}

const publisher = createRedisPublisher({ url, prefix });
const sse = createPublisher<App>(publisher);

/**
 * Typed to the character: the Channel name is checked against `chat:{roomId}` as a template
 * literal, the event against what that Channel declares, and the payload against the schema's
 * Output — with no Registry, no pattern and no schema present at runtime. Nothing validates
 * here, which is why the type is the Output the wire carries (ADR-0006).
 */
const first = await sse.publish("chat:42", "message", { id: "1", text: "from the worker" });
const second = await sse.publish("announcements", "posted", { id: "2", text: "we shipped" });

await publisher.close();

/**
 * What this process ended up holding, which is the other half of the claim.
 *
 * `next` is not in this package's dependencies and not resolvable from anywhere above it, so it
 * is asserted absent as well as unloaded. `react` is resolvable — the workspace root installs it
 * for the library's own tests, and Node walks up — so for React the honest claim is the one made
 * here: no copy of it was ever loaded. That it is absent from what ships is a different check,
 * and `pack:check` makes it against the built import graph of the transport entries.
 *
 * Both libraries ship as CommonJS, so a copy loaded by anyone in this realm is in `require`'s
 * cache, whichever module pulled it.
 */
const required = createRequire(import.meta.url);
const loaded = Object.keys(required.cache).filter((path) =>
  /[\\/]node_modules[\\/](next|react|react-dom)[\\/]/.test(path),
);

let resolvable = true;
try {
  import.meta.resolve("next");
} catch {
  resolvable = false;
}

console.log(JSON.stringify({ cursors: [first, second], loaded, nextResolvable: resolvable }));
