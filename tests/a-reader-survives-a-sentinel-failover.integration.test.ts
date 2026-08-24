import { createSentinel } from "redis";
import { test } from "vitest";

import {
  injectedClientOn,
  readerSurvivesAFailover,
  FAILOVER_TIMEOUT_MS,
  INJECTED_COMMAND_TIMEOUT_MS,
} from "./injected-client-backend.js";
import { SENTINEL_MASTER_NAME, startSentinelFailoverTopology } from "./redis-topologies.js";

/**
 * The blocking reader across a **real sentinel failover** (#79): a master with one replica,
 * watched by a sentinel that is told to promote it while a subscription sits in its
 * `XREAD BLOCK`, reached through an injected `createSentinel` client.
 *
 * The other half of the case #57 left open, and a different failure from the cluster's: no slot
 * moves here, the master a client resolved is simply another server afterwards.
 */
const injected = injectedClientOn(startSentinelFailoverTopology, (topology) =>
  createSentinel({
    name: SENTINEL_MASTER_NAME,
    sentinelRootNodes: topology.nodes,
    commandOptions: { timeout: INJECTED_COMMAND_TIMEOUT_MS },
  }),
);

test(
  "a reader on a Sentinel client keeps the log gap-free across a failover",
  async () => {
    const { client, topology } = injected();

    await readerSurvivesAFailover(client, topology, "sentinel");
  },
  FAILOVER_TIMEOUT_MS,
);
