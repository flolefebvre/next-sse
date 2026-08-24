import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, vi } from "vitest";

import type { TransportContractOptions } from "../packages/next-sse/src/testing/index.js";
import type {
  Retention,
  StoredEntry,
  Transport,
} from "../packages/next-sse/src/transport/index.js";
import type {
  RedisClientLike,
  RedisOperation,
} from "../packages/next-sse/src/transport/redis-client.js";
import { createRedisTransport } from "../packages/next-sse/src/transport/redis.js";

import type { RunningTopology } from "./redis-topologies.js";

/** How long a topology has to come up, image pull included, before the file gives up. */
const TOPOLOGY_TIMEOUT_MS = 180_000;

/** The command timeout an injected client carries here, well under one `XREAD BLOCK`. */
export const INJECTED_COMMAND_TIMEOUT_MS = 1_000;

/** A client of the run's own: one this file brings up and takes down with the topology. */
type OwnedClient = RedisClientLike & {
  connect(): Promise<unknown>;
  close(): Promise<unknown>;
};

/**
 * Bring one topology up for the file that calls this, open the single client every Transport of
 * that file is injected with, and take both down again afterwards — including when the client
 * could not be opened, so that a red run leaves no container behind.
 *
 * It is called at module scope, beside the suite it feeds: what it answers is a getter, because
 * the contract suite is built before any hook has run and must not hold the client itself.
 */
export function injectedClientOn<Client extends OwnedClient>(
  start: () => Promise<RunningTopology>,
  open: (topology: RunningTopology) => Client,
): () => Client {
  let topology: RunningTopology | undefined;
  let client: Client | undefined;

  beforeAll(async () => {
    const started = await start();
    topology = started;

    try {
      const opened = open(started);
      opened.on("error", () => undefined);
      await opened.connect();
      client = opened;
    } catch (error) {
      topology = undefined;
      await started.stop();
      throw error;
    }
  }, TOPOLOGY_TIMEOUT_MS);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await topology?.stop();
  });

  return () => {
    if (client === undefined) throw new Error("the topology this file needs did not come up");

    return client;
  };
}

/** A log of this run's own, which is how one server serves every case (see `create` below). */
function freshPrefix(): string {
  return `next-sse-test-${randomUUID().slice(0, 8)}`;
}

/**
 * The contract suite's view of one real topology reached through a client the caller injected,
 * as an App on Cluster or Sentinel reaches it: **one** long-lived client, shared by every
 * Transport of the run, each Transport on a Prefix of its own and each subscription on a
 * `duplicate()` of that client.
 *
 * `peer` is a second Transport on the same log, through the same client — a second Instance of
 * the App, which is what the multi-Instance cases need. `outage` is deliberately absent: it has
 * to be one Transport's own path to the backend being cut while a peer keeps publishing, and
 * the per-Transport TCP proxy that stages it for a single server has no counterpart in a
 * topology whose client opens a connection per node behind our back. The cases needing it are
 * skipped by name, which is what the suite does with a capability a backend cannot supply
 * honestly.
 */
export function injectedClientContract(client: () => RedisClientLike): TransportContractOptions {
  const opened = new Map<Transport, { prefix: string; retention: Retention }>();

  const open = (prefix: string, retention: Retention): Transport => {
    const transport = createRedisTransport({ client: client(), prefix, retention });
    opened.set(transport, { prefix, retention });

    return transport;
  };

  return {
    create: ({ retention }) => open(freshPrefix(), retention),
    backend: {
      peer: (transport) => {
        const on = opened.get(transport);
        if (on === undefined) throw new Error("that Transport did not come from this backend");

        return open(on.prefix, on.retention);
      },
    },
  };
}

/**
 * How long the log is left quiet: longer than one whole `XREAD BLOCK` of the reader (five
 * seconds), so that the blocking read the injected client's command timeout would abort is
 * demonstrably still in flight when the timeout has long passed.
 */
const QUIET_MS = 8_000;

/** How long the quiet-log case is given: the quiet stretch, and room to deliver after it. */
export const QUIET_LOG_TIMEOUT_MS = 30_000;

/**
 * The reader's connection is `duplicate()`d with no per-command timeout at all (ADR-0006), and
 * this is that override held to its promise on a real topology: a log left quiet for longer
 * than the timeout the injected client carries reports no failure of any kind, and the next
 * Publish still arrives on the live feed.
 *
 * It is a regression guard rather than a discriminating proof, and the difference is worth
 * stating: node-redis 6.2.x drops a command's timeout the moment the command is written to the
 * socket, so on that version the timeout cannot abort an in-flight `XREAD` whether the override
 * is applied or not. The override is still the correct defence — the day node-redis bounds a
 * written command, this case is what says so on Cluster and on Sentinel.
 */
export async function readerSurvivesAQuietLog(client: RedisClientLike): Promise<void> {
  const failures: RedisOperation[] = [];
  const transport = createRedisTransport({
    client,
    prefix: freshPrefix(),
    onError: (_error, operation) => failures.push(operation),
  });
  const seen: StoredEntry[] = [];

  try {
    await transport.subscribe((entry) => seen.push(entry), { onGap: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    expect(failures).toEqual([]);

    await transport.publish({ v: 1, type: "message", channel: "quiet", event: "tick", payload: 1 });
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5_000, interval: 25 });
    expect(failures).toEqual([]);
  } finally {
    await transport.close();
  }
}
