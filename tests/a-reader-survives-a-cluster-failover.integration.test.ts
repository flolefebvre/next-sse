import { createCluster } from "redis";
import { test } from "vitest";

import {
  injectedClientOn,
  readerSurvivesAFailover,
  FAILOVER_TIMEOUT_MS,
  INJECTED_COMMAND_TIMEOUT_MS,
} from "./injected-client-backend.js";
import { startClusterFailoverTopology } from "./redis-topologies.js";

/**
 * The blocking reader across a **real cluster failover** (#79): three masters with a replica
 * each, reached through an injected `createCluster` client, and the replica of the shard the
 * log sits on promoted under a subscription that is mid-`XREAD BLOCK`.
 *
 * This is the case #57 left open. The cluster is the one topology where the slot itself moves:
 * the connection the reader blocks on stays up and stops being the one that owns the key.
 */
const injected = injectedClientOn(startClusterFailoverTopology, (topology) =>
  createCluster({
    rootNodes: topology.nodes.map((node) => ({ socket: node })),
    commandOptions: { timeout: INJECTED_COMMAND_TIMEOUT_MS },
  }),
);

test(
  "a reader on a Cluster client keeps the log gap-free across a failover",
  async () => {
    const { client, topology } = injected();

    await readerSurvivesAFailover(client, topology, "cluster");
  },
  FAILOVER_TIMEOUT_MS,
);
