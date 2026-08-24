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
 * The blocking reader when the Sentinel master **dies ungracefully** (#81): the same topology
 * as the graceful case, but the master the reader is demonstrably sitting on is shut down where
 * it stands rather than told to hand over.
 *
 * This is the failover managed Redis actually produces when a node is lost, and the only one
 * that can reach the Transport's reconnect branch on Sentinel: `SENTINEL FAILOVER` (#79) leaves
 * the demoted node serving the blocked `XREAD` from replicated data, so nothing there is ever
 * reconnected. Here the socket goes away with the process, and there is no master at all until
 * the sentinel has called the old one down and elected the replica — which is why this case is
 * bounded by a bigger number than the graceful one, and why that number is the sentinel's own
 * `down-after-milliseconds` and `failover-timeout` plus the reader's.
 */
const injected = injectedClientOn(startSentinelFailoverTopology, (topology) =>
  createSentinel({
    name: SENTINEL_MASTER_NAME,
    sentinelRootNodes: topology.nodes,
    commandOptions: { timeout: INJECTED_COMMAND_TIMEOUT_MS },
  }),
);

test(
  "a reader on a Sentinel client keeps the log gap-free when the master is killed under it",
  async () => {
    const { client, topology } = injected();

    await readerSurvivesAFailover(client, { action: "kill", topology }, "sentinel (killed)");
  },
  FAILOVER_TIMEOUT_MS,
);
