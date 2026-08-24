import { createCluster } from "redis";
import { test } from "vitest";

import { transportContract } from "../packages/next-sse/src/testing/index.js";

import {
  injectedClientContract,
  injectedClientOn,
  readerSurvivesAQuietLog,
  INJECTED_COMMAND_TIMEOUT_MS,
  QUIET_LOG_TIMEOUT_MS,
} from "./injected-client-backend.js";
import { startClusterTopology } from "./redis-topologies.js";

/**
 * The Transport on a **real cluster of three masters**, reached through an injected
 * `createCluster` client (#57): the very suite a third party runs against their own log
 * (ADR-0009), with every command routed by the one log key to whichever master owns its slot
 * rather than sent down a single connection.
 *
 * The client carries a per-command timeout on purpose — it is what an App tuning its own client
 * would set, and what the reader's `duplicate()` has to clear.
 */
const injected = injectedClientOn(startClusterTopology, (topology) =>
  createCluster({
    rootNodes: topology.nodes.map((node) => ({ socket: node })),
    commandOptions: { timeout: INJECTED_COMMAND_TIMEOUT_MS },
  }),
);

transportContract(injectedClientContract(() => injected().client));

test(
  "a reader duplicated from a Cluster client outlives that client's command timeout",
  async () => readerSurvivesAQuietLog(injected().client),
  QUIET_LOG_TIMEOUT_MS,
);
