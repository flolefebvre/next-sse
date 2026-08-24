import { createRequire } from "node:module";

import { selectTransport } from "../packages/next-sse/src/server/select-transport.js";

/**
 * What a process that took the zero-config path has loaded, printed as one line of JSON.
 *
 * It runs in a child of its own because that is the only honest way to ask the question: a test
 * runner's worker has already imported half the package, and what matters is what an App's
 * process ends up holding. node-redis ships as CommonJS, so a copy of it that was loaded at all
 * is in this realm's `require` cache, whoever imported it.
 *
 * The Transport is exercised, not merely built: the Memory path publishes and reads, and the
 * Redis path answers a Cursor no Stream could have minted — which loads the module and builds
 * the client without connecting to anything.
 */
const transport = selectTransport();

if (process.env.REDIS_URL === undefined || process.env.REDIS_URL === "") {
  await transport.publish({
    v: 1,
    type: "message",
    channel: "chat:42",
    event: "message",
    payload: { text: "one" },
  });
  await transport.read(undefined, 10);
} else {
  await transport.read("not-a-cursor", 10);
}

const required = createRequire(import.meta.url);
const loaded = Object.keys(required.cache).some((path) => /[\\/](@redis|redis)[\\/]/.test(path));

console.log(JSON.stringify({ loaded }));

await transport.close();
