import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const run = promisify(execFile);

const PROBE = new URL("./loaded-modules-probe.ts", import.meta.url).pathname;

/**
 * What a process that took the zero-config path has loaded. The probe runs in a child of its
 * own: this worker has already imported the package, so only a fresh process can answer what an
 * App's process really ends up holding.
 */
async function loadedNodeRedis(env: NodeJS.ProcessEnv): Promise<boolean> {
  const { stdout } = await run("npx", ["tsx", PROBE], {
    env: { ...process.env, REDIS_URL: "", ...env },
  });
  const line = stdout.trim().split("\n").at(-1) ?? "";

  return (JSON.parse(line) as { loaded: boolean }).loaded;
}

/**
 * The subpath split of ADR-0008 only pays for itself if the Memory path never pulls node-redis
 * in: `redis` is a plain dependency, so nothing but the import graph keeps it out of an App
 * that does not use it.
 */
test("an App with no REDIS_URL never loads node-redis", async () => {
  expect(await loadedNodeRedis({})).toBe(false);
}, 120_000);

/** And the probe has teeth: the same check sees node-redis the moment the Redis path is taken. */
test("an App with REDIS_URL does load it", async () => {
  expect(await loadedNodeRedis({ REDIS_URL: "redis://127.0.0.1:6379" })).toBe(true);
}, 120_000);
