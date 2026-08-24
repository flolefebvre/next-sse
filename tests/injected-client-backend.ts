import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, vi } from "vitest";

import type { TransportContractOptions } from "../packages/next-sse/src/testing/index.js";
import type {
  Entry,
  Retention,
  StoredEntry,
  Transport,
} from "../packages/next-sse/src/transport/index.js";
import type {
  RedisClientLike,
  RedisOperation,
} from "../packages/next-sse/src/transport/redis-client.js";
import { createRedisTransport } from "../packages/next-sse/src/transport/redis.js";
import { logKeyOf } from "../packages/next-sse/src/transport/redis-reply.js";

import type { FailoverTopology, KillableTopology, RunningTopology } from "./redis-topologies.js";
import { SENTINEL_DOWN_AFTER_MS, SENTINEL_FAILOVER_TIMEOUT_MS } from "./redis-topologies.js";

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
 * the contract suite is built before any hook has run and must not hold the client itself. The
 * getter answers the topology beside the client, which is what a case that has to act on the
 * servers themselves — force a failover (#79) — needs and the contract suite ignores.
 */
export function injectedClientOn<Topology extends RunningTopology, Client extends OwnedClient>(
  start: () => Promise<Topology>,
  open: (topology: Topology) => Client,
): () => { client: Client; topology: Topology } {
  let topology: Topology | undefined;
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
    if (client === undefined || topology === undefined) {
      throw new Error("the topology this file needs did not come up");
    }

    return { client, topology };
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

/**
 * How long the reader is given to deliver the Publish that follows a promotion, and the bound
 * the docs state.
 *
 * It is derived, not picked: the reader sits in an `XREAD BLOCK` on a socket the promotion may
 * leave nothing coming down, and node-redis 6.2.x cannot abort a command it has already
 * written (ADR-0006) — so the longest that read can sit is the client's `socketTimeout`, 15 s
 * (`redis-client.ts`), after which the socket is torn down, the loop reports the failure and
 * resumes. This is that, plus the loop's reissue pause and a round trip, rounded up.
 */
export const FAILOVER_DELIVERY_BOUND_MS = 20_000;

/**
 * The same bound for the failover nobody arranged: the master's process dies where it stands
 * (#81). It is a different number because a kill is a *detection*, not a handover — the reader
 * has nothing to be routed to until the sentinel has noticed and elected.
 *
 * Derived, in the order the clock runs, and every term of it named: the sentinel will not call
 * the master down before `down-after-milliseconds` (1 s, stated in the topology's sentinel
 * config), the handover that follows is bounded by `failover-timeout` (5 s), and only then does
 * the reader have somewhere to go — where the bound above already applies in full (the 15 s
 * `socketTimeout` a written `XREAD` can sit for, plus the reissue pause and a round trip). So:
 * 1 s + 5 s + 20 s = 26 s.
 */
const KILLED_MASTER_BOUND_MS =
  SENTINEL_DOWN_AFTER_MS + SENTINEL_FAILOVER_TIMEOUT_MS + FAILOVER_DELIVERY_BOUND_MS;

/** How long the client is given to find the promoted master again before the case Publishes. */
const FAILOVER_USABLE_BOUND_MS = 20_000;

/** How long the whole failover case is given: the promotion, then both bounds above, with room. */
export const FAILOVER_TIMEOUT_MS = 120_000;

/**
 * Which failover a case forces, with the topology that can stage it. A discriminated pair
 * rather than a name beside a topology: only a `KillableTopology` can be killed, so the type
 * says what the action needs instead of a method throwing when it is not there.
 */
export type Failover =
  | { action: "promote"; topology: FailoverTopology }
  | { action: "kill"; topology: KillableTopology };

/** What the failover the case forced is called in what it prints, and which issue observed it. */
const failoverNames = {
  promote: { what: "the promotion", issue: "#79" },
  kill: { what: "the kill", issue: "#81" },
} as const;

/** One failure this Transport reported, kept with the moment it was reported. */
interface Reported {
  at: number;
  what: string;
}

/**
 * What a blocking reader does while the master under it is replaced — the one runtime behaviour
 * on Cluster and on Sentinel that #57 left asserted by reasoning (#79).
 *
 * The case is the deployment's: subscribe, see a Publish, force the failover the caller asked
 * for — the replica promoted under the reader (#79), or the master killed outright under it
 * (#81) — and Publish again once the topology reports the new master. What it asserts is the
 * promise an App holds the log to — both Entries, in order, inside the bound that failover is
 * worth, stated in one place above — so that an unbounded hang fails here rather than in
 * production. A Reset in between is recorded and
 * printed rather than failed: ADR-0004 makes it an acceptable way through a failover, and which
 * way through it goes is the ADR's to describe, not this case's to pin.
 *
 * The write path has to find the new master too, and that is not what this case is about — but
 * it cannot be retried past, either: an `XADD` that failed its deadline may still have been
 * written, so a retried Publish is a Publish that may land twice. So the case waits for the
 * client with a `tail`, which reads and writes nothing and can be asked again for as long as it
 * takes, and Publishes exactly once after it. What that wait costs is measured with the rest.
 *
 * The bound is the one the failover it was handed is worth: a handover is over as soon as the
 * cluster or the sentinel says so, a kill cannot even begin before the sentinel has noticed.
 */
export async function readerSurvivesAFailover(
  client: RedisClientLike,
  failover: Failover,
  where: string,
): Promise<void> {
  const bound = failover.action === "kill" ? KILLED_MASTER_BOUND_MS : FAILOVER_DELIVERY_BOUND_MS;
  const usableBound =
    failover.action === "kill" ? KILLED_MASTER_BOUND_MS : FAILOVER_USABLE_BOUND_MS;
  const named = failoverNames[failover.action];
  const prefix = freshPrefix();
  const failures: Reported[] = [];
  const gaps: Reported[] = [];
  const transport = createRedisTransport({
    client,
    prefix,
    onError: (error, operation) =>
      failures.push({ at: Date.now(), what: `${operation}: ${String(error)}` }),
  });
  const seen: StoredEntry[] = [];

  try {
    await transport.subscribe((entry) => seen.push(entry), {
      onGap: (resumeFrom) => gaps.push({ at: Date.now(), what: `reset at ${resumeFrom}` }),
    });
    await transport.publish(tick("before"));
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5_000, interval: 25 });

    const key = logKeyOf(prefix);
    if (failover.action === "kill") await failover.topology.kill(key);
    else await failover.topology.promote(key);
    const promoted = Date.now();

    await vi.waitFor(() => transport.tail(), {
      timeout: usableBound,
      interval: 100,
    });
    const usable = Date.now();
    await transport.publish(tick("after"));
    const published = Date.now();

    await vi.waitFor(() => expect(seen).toHaveLength(2), {
      timeout: bound,
      interval: 25,
    });
    const delivered = Date.now();

    /**
     * The measurement is the point of the case as much as the assertion is: the bound above and
     * what ADR-0006 says about failover are only worth what a run can be held to, so every run
     * prints what it actually took.
     */
    console.info(
      `[${named.issue}] ${where}: the log was readable again ${String(usable - promoted)}ms ` +
        `after ${named.what}, the Publish accepted ${String(published - usable)}ms after that and ` +
        `delivered ${String(delivered - published)}ms after that; ` +
        `${String(gaps.length)} reset(s)${describe(gaps, promoted)}; ` +
        `${String(failures.length)} reported failure(s)${describe(failures, promoted)}`,
    );

    expect(seen.map((entry) => entry.type === "message" && entry.payload)).toEqual([
      "before",
      "after",
    ]);
  } finally {
    await transport.close();
  }
}

/** One Message of the failover case, told apart by what it was published either side of. */
function tick(payload: string): Entry {
  return { v: 1, type: "message", channel: "failover", event: "tick", payload };
}

/** What was reported, and when, relative to the moment the promotion became visible. */
function describe(reported: Reported[], since: number): string {
  return reported.length === 0
    ? ""
    : ` [${reported.map((one) => `+${String(one.at - since)}ms ${one.what}`).join("; ")}]`;
}
