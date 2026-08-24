import { afterAll, inject } from "vitest";

import { transportContract } from "../packages/next-sse/src/testing/index.js";

import { redisContractBackend } from "./redis-contract-backend.js";

/**
 * The multi-Instance Transport, put through the very suite a third party runs against their own
 * log (ADR-0009), on the real server this run was given — `redis:8` or `valkey/valkey:8`,
 * whichever `NEXT_SSE_TEST_IMAGE` named.
 *
 * Both backend hooks are supplied, so every case runs and none is skipped: a peer is a second
 * Transport on the same log, and an outage is that Transport's own path to the server being cut
 * while the peer keeps publishing.
 */
const backend = redisContractBackend(() => inject("redisUrl"));

transportContract(backend.options);

afterAll(async () => {
  await backend.close();
});
