import { createSentinel } from "redis";
import { test } from "vitest";

import { transportContract } from "../packages/next-sse/src/testing/index.js";

import {
  injectedClientContract,
  injectedClientOn,
  readerSurvivesAQuietLog,
  INJECTED_COMMAND_TIMEOUT_MS,
  QUIET_LOG_TIMEOUT_MS,
} from "./injected-client-backend.js";
import { SENTINEL_MASTER_NAME, startSentinelTopology } from "./redis-topologies.js";

/**
 * The Transport on a **real master watched by a sentinel**, reached through an injected
 * `createSentinel` client (#57): the same suite again, with every command — the reader's
 * blocking `XREAD` included — asked of the master the sentinel names, which is the one thing
 * this client kind decides for us.
 *
 * Failover is out of scope here (#57): what a reader does across one is a claim of its own, and
 * this topology has no replica to fail over to.
 */
const injected = injectedClientOn(startSentinelTopology, (topology) =>
  createSentinel({
    name: SENTINEL_MASTER_NAME,
    sentinelRootNodes: topology.nodes,
    commandOptions: { timeout: INJECTED_COMMAND_TIMEOUT_MS },
  }),
);

transportContract(injectedClientContract(() => injected().client));

test(
  "a reader duplicated from a Sentinel client outlives that client's command timeout",
  async () => readerSurvivesAQuietLog(injected().client),
  QUIET_LOG_TIMEOUT_MS,
);
