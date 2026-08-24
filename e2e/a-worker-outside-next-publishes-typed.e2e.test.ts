import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { expect, inject, test } from "vitest";

import { createRedisTransport } from "../packages/next-sse/src/transport/redis.js";

const run = promisify(execFile);

/**
 * The fixture stays under `tests/` beside `dist-consumer`: the two are the same kind of thing —
 * a package that resolves `@flefebvre/next-sse` the way an installed consumer does — and both
 * are wired into `typecheck:dist`. What runs here is the scenario, not the fixture.
 */
const WORKER = new URL("../tests/worker-consumer/worker.ts", import.meta.url).pathname;

/** What the worker prints about the run it just made, as one line of JSON. */
interface WorkerReport {
  cursors: string[];
  loaded: string[];
  nextResolvable: boolean;
}

/**
 * The Publisher half of ADR-0005, from the process it exists for: a package with no Next.js
 * anywhere in its dependencies, resolving `@flefebvre/next-sse` through the real exports map
 * against the built `dist`.
 *
 * It is an e2e scenario because its subject is the built package. That is what this project is
 * for — the example app is its main tenant, not its definition — and it is the only phase that
 * runs after `build`, which a scenario resolving `dist` requires. A run started without one
 * never reaches here: the project's own setup asserts the built output first, so the failure
 * names the missing build rather than surfacing as an unresolved module inside a scenario.
 *
 * It runs in a child of its own because the claim is about a whole process. This worker has
 * already imported half the library — and, being a test worker, React as well — so only a fresh
 * process can answer what a consumer's worker really ends up holding.
 */
async function runWorker(prefix: string): Promise<WorkerReport> {
  const { stdout } = await run(process.execPath, ["--import", "tsx", WORKER], {
    env: { ...process.env, REDIS_URL: inject("redisUrl"), NEXT_SSE_PREFIX: prefix },
  });
  const line = stdout.trim().split("\n").at(-1) ?? "";

  return JSON.parse(line) as WorkerReport;
}

test("a worker with no Next.js installed Publishes typed into the App's log", async () => {
  const prefix = `next-sse-test-${randomUUID().slice(0, 8)}`;

  const report = await runWorker(prefix);

  /**
   * What the App's Instances will read. The worker held no Registry, no pattern and no schema,
   * and what it wrote is nevertheless an ordinary Entry of this App's log — the same envelope a
   * bound Handle writes (ADR-0006), on the Channel names its patterns make.
   */
  const transport = createRedisTransport({ url: inject("redisUrl"), prefix });
  try {
    const page = await transport.read(undefined, 10);

    expect(page).toMatchObject({
      entries: [
        {
          v: 1,
          type: "message",
          channel: "chat:42",
          event: "message",
          payload: { id: "1", text: "from the worker" },
          cursor: report.cursors[0],
        },
        {
          v: 1,
          type: "message",
          channel: "announcements",
          event: "posted",
          payload: { id: "2", text: "we shipped" },
          cursor: report.cursors[1],
        },
      ],
    });
  } finally {
    await transport.close();
  }
});

/**
 * The other half of the boundary: `./transport` and below never import Next.js or React
 * (ADR-0008), so a worker that Publishes loads neither. The `import type` of the Registry the
 * worker makes is erased before Node sees it, which is why naming an App costs a worker nothing
 * — and why the throwing `default` condition of `./server` never fires for it.
 */
test("that worker loads no Next.js and no React, and has no Next.js to load", async () => {
  const report = await runWorker(`next-sse-test-${randomUUID().slice(0, 8)}`);

  expect(report.loaded).toEqual([]);
  expect(report.nextResolvable).toBe(false);
});
