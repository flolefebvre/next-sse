import { createServer } from "node:net";

import { createClient } from "redis";
import {
  GenericContainer,
  getContainerRuntimeClient,
  StartupCheckStrategy,
  type StartedTestContainer,
  type StartupStatus,
} from "testcontainers";

import { takingHostPorts, TOPOLOGY_LABEL, type Containers } from "./topology-start.js";
import { testImage } from "./valkey-container.js";

/** The master a Sentinel topology monitors, as both the sentinel and the client name it. */
export const SENTINEL_MASTER_NAME = "mymaster";

/** How long a topology may take to come up: several servers and a cluster handshake. */
const STARTUP_TIMEOUT_MS = 120_000;

/** What the container prints once every server is up and the topology has settled. */
const READY = "TOPOLOGY READY";

/**
 * How long a promotion has to become visible to every node of the topology before `promote`
 * gives up. A `CLUSTER FAILOVER` or a `SENTINEL FAILOVER` is a coordinated handover, not a
 * failure detection: it takes a round of gossip, not a node timeout. Well above that, and
 * bounded, because a promotion that never lands must fail the test rather than hang it.
 *
 * On Sentinel the last of the three things `promoteInSentinel` waits for — the old master
 * reconfigured into a connected replica — is the one that sets this bound, and it is not on the
 * handover's clock at all (#86). The sentinel only reconfigures it on an INFO round, and only
 * once it has been reporting the role it reports for longer than four publish periods, so the
 * derivation is: the handover itself (`failover-timeout`, 5 s) + 4 × publish period + one INFO
 * period + the resync the demoted server then runs. With the periods shortened below that is
 * 5 s + 2 s + 0.5 s + a resync of a log a test just wrote, and this ceiling is many times it —
 * which is the margin a loaded host eats into, and left generous on purpose.
 */
const PROMOTION_TIMEOUT_MS = 30_000;

/** How often the readiness of a promotion is re-read while it is being waited for. */
const PROMOTION_POLL_MS = 100;

/**
 * How long the sentinel waits before it calls a master it cannot reach down, and how long it
 * then gives itself to finish the handover. Both are stated in the sentinel's config rather
 * than left to the defaults (30 s and 3 min) because together they are what an ungraceful
 * failover costs: nothing can be promoted until the first has elapsed, and the handover that
 * follows is bounded by the second. The case that kills a master derives its own bound from
 * these two numbers, by name (#81).
 */
export const SENTINEL_DOWN_AFTER_MS = 1_000;
export const SENTINEL_FAILOVER_TIMEOUT_MS = 5_000;

/**
 * How often the sentinel re-reads each server's `INFO`, and how often it publishes its hello —
 * both far below their defaults (10 s and 2 s), which is what makes a promotion observable on
 * this topology in seconds rather than on a ten-second grid (#86).
 *
 * The two are not decoration and they are not a sleep being widened: a sentinel reconfigures
 * the *old* master into a replica of the promoted one from an `INFO` round, and only once that
 * server has been reporting `master` for longer than four publish periods. Measured on a loaded
 * host with the defaults, `+convert-to-slave` came 10.3 s after `+switch-master`, and one
 * missed round would have cost ten more; with these values it came 2.2 s after it. The
 * observable is unchanged — the sentinel is asked the same three questions, and what they prove
 * is the same — only how often it looks.
 *
 * They are set through `SENTINEL DEBUG`, the only way to reach them: they are internal periods
 * rather than configuration file directives. Redis has carried the command since 6.2 and Valkey
 * inherits it, so both cells of the CI matrix take it.
 */
const SENTINEL_INFO_PERIOD_MS = 500;
const SENTINEL_PUBLISH_PERIOD_MS = 500;

/**
 * How long the replica is given to acknowledge everything the master holds before that master
 * is killed (see `killInSentinel`). Generous, and bounded: a `WAIT` that runs out is a topology
 * that is not replicating, which has to fail the test loudly rather than be killed anyway.
 */
const REPLICATION_CATCHUP_MS = 10_000;

/** The one key the kill writes itself, so that its `WAIT` covers what the case published. */
const REPLICATION_PROBE_KEY = "next-sse-test-replication-probe";

/**
 * What a topology's start comes to: the ports it takes, the script its container runs on them,
 * and whatever the caller has to remember of the ports it just picked — the sentinel's, when
 * there is one. It is planned in a function rather than passed in, because a start that loses
 * its ports is run again from here, and the ports it picks the second time must be new ones.
 */
interface Planned<T> {
  ports: number[];
  script: string;
  of: T;
}

/** A topology that is up and settled, beside what its plan remembered of its ports. */
interface Started<T> {
  topology: RunningTopology;
  of: T;
}

/**
 * Docker, as sweeping up after a start that failed needs it: everything carrying that label,
 * whatever state it is in, and gone for good.
 *
 * Listed through dockerode itself rather than testcontainers' `fetchByLabel`, which lists only
 * what is running — and the container a refused port binding leaves behind was never started.
 */
const containers: Containers = {
  labelled: async (label) => {
    const { dockerode } = (await getContainerRuntimeClient()).container;
    const found = await dockerode.listContainers({
      all: true,
      filters: { label: [`${TOPOLOGY_LABEL}=${label}`] },
    });

    return found.map((container) => container.Id);
  },
  remove: async (id) => {
    const { dockerode } = (await getContainerRuntimeClient()).container;
    await dockerode.getContainer(id).remove({ force: true, v: true });
  },
};

/**
 * The readiness testcontainers is given: none of its own. Being up with its ports bound is all
 * this container is waited for under the turn; what the servers inside it are doing is waited
 * for in `settled`, where waiting costs nobody else their turn.
 *
 * It extends the strategy testcontainers exports rather than restating the `WaitStrategy`
 * interface, so that an interface this project does not own changing under it is a compile
 * error here and not a shape that silently no longer fits.
 */
class UpIsReadyEnough extends StartupCheckStrategy {
  checkStartupState(): Promise<StartupStatus> {
    return Promise.resolve("SUCCESS");
  }
}

const AS_SOON_AS_IT_IS_UP = new UpIsReadyEnough().withStartupTimeout(STARTUP_TIMEOUT_MS);

/**
 * Wait for the container to print the one line its script ends with, on the same bound and with
 * the same meaning testcontainers' own log wait had: the topology is up, every server answers,
 * and a cluster has agreed on its slots. The log is read from the container's first line, so a
 * topology that settled while this was being set up is not waited for anyway.
 *
 * What is thrown says what happened — the line never came, or the log ended before it did, which
 * is a container whose script died — because a topology that never settles has to be a readable
 * failure rather than a hook that times out.
 */
async function settled(container: StartedTestContainer): Promise<void> {
  const logs = await container.logs({ since: 0 });
  let tail = "";

  try {
    await new Promise<void>((resolve, reject) => {
      const giveUp = setTimeout(() => {
        reject(
          new Error(
            `the topology did not print "${READY}" within ${String(STARTUP_TIMEOUT_MS)}ms; ` +
              `its log ends with: ${tail}`,
          ),
        );
      }, STARTUP_TIMEOUT_MS);
      const done = (settle: () => void) => {
        clearTimeout(giveUp);
        settle();
      };
      const read = (chunk: unknown) => {
        tail = (tail + String(chunk)).slice(-1_000);
        if (tail.includes(READY)) done(resolve);
      };

      logs
        .on("data", read)
        .on("err", read)
        .on("error", (error: Error) => done(() => reject(error)))
        .on("end", () =>
          done(() =>
            reject(new Error(`the topology's log ended before "${READY}"; it ends with: ${tail}`)),
          ),
        );
    });
  } finally {
    logs.destroy();
  }
}

/** One running topology, and the way to stop it. */
export interface RunningTopology {
  /** The nodes a client of this topology is pointed at, reachable from this process. */
  nodes: { host: string; port: number }[];
  stop(): Promise<void>;
}

/**
 * A topology that has a replica to fail over to, and knows how to force the failover.
 *
 * It is a type of its own rather than an optional method on every topology: whether a
 * promotion is possible is decided when the topology is started, and a `promote` that throws
 * on the topologies without a replica would say otherwise.
 */
export interface FailoverTopology extends RunningTopology {
  /**
   * Promote the replica of the master that serves `key`, and answer only once every node of
   * the topology reports the promotion — so that a test never has to sleep for gossip.
   *
   * The key is what picks the shard on a Cluster; a Sentinel topology has one master and
   * ignores it. Throws, with what it last saw, when the promotion has not landed in time.
   */
  promote(key: string): Promise<void>;
}

/**
 * A failover topology whose master can also be taken away outright, with no handover: the
 * process dies where it stands and the failure has to be detected rather than announced.
 *
 * Separate from `FailoverTopology` for the same reason that one is separate from
 * `RunningTopology`: only the topologies that can actually be killed carry `kill`, so a case
 * asking for that failure cannot be pointed at a topology that cannot stage it (#81).
 */
export interface KillableTopology extends FailoverTopology {
  /**
   * Kill the master a blocking reader currently sits on — hard, `SHUTDOWN NOSAVE` — and answer
   * only once a different node has been promoted in its place.
   *
   * `key` names the log whose reader must be on the doomed node when it dies; that is asserted
   * before the kill, not assumed. Throws, with what it last saw, when the reader never showed
   * up there, when the replica never caught up, or when nothing was promoted in time.
   *
   * Answers **the moment `SHUTDOWN NOSAVE` was issued**. Everything before it — finding the
   * reader, waiting for the replica — is staging, and a case whose bound counts the sentinel's
   * detection and election has to start its clock at the death itself, not at the staging.
   */
  kill(key: string): Promise<number>;
}

/**
 * Ports nothing is listening on, all held at once and released together, so that the nodes of
 * a cluster can never be handed the same number twice.
 */
async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, async () => {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

      return server;
    }),
  );
  const ports = servers.map((server) => {
    const address = server.address();

    return typeof address === "object" && address !== null ? address.port : 0;
  });
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));

  return ports;
}

/**
 * The nodes of a cluster: the port a client reaches each one on, and the port it gossips on.
 * Two ports per node, taken free in one batch so that no two of them are the same number.
 *
 * The gossip port is stated rather than left to default, and that is not a detail: a node's bus
 * port defaults to its client port plus ten thousand, and a node whose client port is above
 * 55535 refuses to start at all — while `listen(0)` picks from an ephemeral range that on a
 * Linux CI runner (32768–60999) runs well past that. Left to the default, roughly one node in
 * three would be handed a port the server rejects. Only the client ports are published to the
 * host: the bus is spoken inside the container, between nodes that share one network namespace.
 */
async function clusterNodes(count: number): Promise<{ client: number; bus: number }[]> {
  const nodes: { client: number; bus: number }[] = [];
  let client: number | undefined;

  for (const port of await freePorts(count * 2)) {
    if (client === undefined) client = port;
    else {
      nodes.push({ client, bus: port });
      client = undefined;
    }
  }

  return nodes;
}

/**
 * One container running every server of a topology, each on a port published to the host under
 * **the same number it uses inside the container**.
 *
 * That identity is the whole trick, and it is not an accident of convenience: a Cluster client
 * follows the addresses `CLUSTER SLOTS` announces, and a Sentinel client follows the address
 * `SENTINEL get-master-addr-by-name` answers. Those addresses are what the servers know of
 * themselves — `127.0.0.1:<port>` — so they are only usable by a client outside the container
 * when `127.0.0.1:<port>` means the same server on both sides of the boundary. Testcontainers'
 * usual random host mapping breaks exactly that, and so does one container per node on a Docker
 * network: this machine's Docker (Desktop on WSL) routes neither bridge addresses nor host
 * networking back to the test process. Hence: one network namespace for the whole topology, and
 * a fixed host binding per port. The ports are taken free at runtime, so two runs on one machine
 * still do not collide.
 *
 * Nothing about that identity can be handed to Docker to choose: `cluster-announce-*` and the
 * sentinel's `announce-*` change the address a server publishes **to everyone**, and the peers
 * that follow it are inside this container, where a host-published port is not bound and
 * `127.0.0.1` is the container's own loopback. One address has to mean the same server on both
 * sides of the boundary, so the numbers are picked here — and what picking them costs, a window
 * in which another worker can take one and a queue of containers hitting Docker's port
 * publishing at once, is what the turn `takingHostPorts` grants covers (#83).
 *
 * The turn is given back the moment Docker has the ports bound, and the topology is then waited
 * for outside it. That line is where the cost is: binding the ports is a second, while settling
 * a cluster is tens of them, and five files that must settle one after another run past the
 * budget their `beforeAll` has. So testcontainers is told the container is ready as soon as it
 * is up, and `READY` — the same line, on the same bound — is waited for here instead. A wait
 * that ends any other way stops the container: nothing else would, since nobody holds it yet.
 *
 * The image is whatever `testImage()` names, unchanged: the official Valkey image ships
 * `redis-server`, `redis-cli` and `redis-sentinel` compatibility names, so one script drives
 * both cells of the CI matrix.
 */
async function startTopology<T>(plan: () => Promise<Planned<T>>): Promise<Started<T>> {
  const { ports, container, of } = await takingHostPorts(
    async (label) => {
      const planned = await plan();
      const container: StartedTestContainer = await new GenericContainer(testImage())
        .withExposedPorts(...planned.ports.map((port) => ({ container: port, host: port })))
        .withCommand(["sh", "-c", planned.script])
        .withLabels({ [TOPOLOGY_LABEL]: label })
        .withWaitStrategy(AS_SOON_AS_IT_IS_UP)
        .start();

      return { ...planned, container };
    },
    { containers },
  );

  try {
    await settled(container);
  } catch (error) {
    await container.stop().catch(() => undefined);

    throw error;
  }

  return {
    topology: {
      nodes: ports.map((port) => ({ host: "127.0.0.1", port })),
      stop: async () => {
        await container.stop();
      },
    },
    of,
  };
}

/**
 * A real cluster of three masters, every slot covered, with `replicas` replicas of each: the
 * shape a Transport's commands are routed by their key on, and — with a replica — the shape a
 * slot's master can move on.
 */
async function startCluster(replicas: number): Promise<RunningTopology> {
  const { topology } = await startTopology(async () => {
    const nodes = await clusterNodes(3 * (1 + replicas));
    const ports = nodes.map((node) => node.client);
    const addresses = ports.map((port) => `127.0.0.1:${String(port)}`).join(" ");
    const servers = nodes
      .map(
        ({ client, bus }) =>
          `redis-server --port ${String(client)} --cluster-port ${String(bus)} --cluster-enabled yes --cluster-config-file "/tmp/node-${String(client)}.conf" --cluster-node-timeout 5000 --appendonly no --save '' --dir /tmp &`,
      )
      .join("\n    ");

    return {
      ports,
      of: undefined,
      script: `
    set -e
    ${servers}
    for port in ${ports.join(" ")}; do
      until redis-cli -p "$port" ping 2>/dev/null | grep -q PONG; do sleep 0.1; done
    done
    redis-cli --cluster create ${addresses} --cluster-replicas ${String(replicas)} --cluster-yes
    for port in ${ports.join(" ")}; do
      until redis-cli -p "$port" cluster info | grep -q 'cluster_state:ok'; do sleep 0.1; done
      until redis-cli -p "$port" info replication | grep -qE 'role:master|master_link_status:up'; do sleep 0.1; done
    done
    echo "${READY}"
    wait
  `,
    };
  });

  return topology;
}

/**
 * A real cluster of three masters, every slot covered and no replica: enough for a Transport's
 * commands to be routed by their key to a master that is not the one the client was pointed at,
 * which is the thing a Cluster client is there to do.
 */
export async function startClusterTopology(): Promise<RunningTopology> {
  return startCluster(0);
}

/**
 * The same cluster with one replica per master, and the way to promote one (#79): the shape a
 * managed Redis has, and the only shape on which the slot a blocking reader sits on can move to
 * another node.
 *
 * It is a separate entry point so that the files that do not force a failover start three
 * servers rather than six.
 */
export async function startClusterFailoverTopology(): Promise<FailoverTopology> {
  const topology = await startCluster(1);

  return {
    ...topology,
    promote: (key) => promoteInCluster(topology.nodes, key),
  };
}

/**
 * A real master watched by one sentinel, with `replicas` replicas of it. The node the topology
 * answers is the sentinel, which is what a Sentinel client is pointed at. Every port is
 * published to the host all the same, and has to be: the client is sent to the master by the
 * address the sentinel answers, and every command of the Transport then goes there.
 */
async function startSentinel(replicas: number): Promise<{
  topology: RunningTopology;
  sentinel: number;
}> {
  const { topology, of: sentinel } = await startTopology(async () => {
    const ports = await freePorts(2 + replicas);
    const [master, sentinel, ...rest] = ports;
    if (master === undefined || sentinel === undefined) throw new Error("no free port to take");

    const followers = rest
      .map(
        (port) =>
          `redis-server --port ${String(port)} --replicaof 127.0.0.1 ${String(master)} --appendonly no --save '' --dir /tmp &`,
      )
      .join("\n    ");

    /**
     * The sentinel is only ready for a forced failover once it has discovered the replica through
     * the master's `INFO`: asked before that, `SENTINEL FAILOVER` answers `NOGOODSLAVE`. So the
     * script waits for the replica to be counted rather than for a duration.
     */
    const discovered =
      replicas === 0
        ? ""
        : `until [ "$(redis-cli -p ${String(sentinel)} sentinel master ${SENTINEL_MASTER_NAME} | grep -A1 '^num-slaves$' | tail -n1 | tr -d '\\r')" = "${String(replicas)}" ]; do sleep 0.1; done`;

    return {
      ports,
      of: sentinel,
      script: `
    set -e
    redis-server --port ${String(master)} --appendonly no --save '' --dir /tmp &
    until redis-cli -p ${String(master)} ping 2>/dev/null | grep -q PONG; do sleep 0.1; done
    ${followers}
    for port in ${ports.filter((port) => port !== sentinel).join(" ")}; do
      until redis-cli -p "$port" ping 2>/dev/null | grep -q PONG; do sleep 0.1; done
      until redis-cli -p "$port" info replication | grep -qE 'role:master|master_link_status:up'; do sleep 0.1; done
    done
    cat > /tmp/sentinel.conf <<EOF
port ${String(sentinel)}
sentinel monitor ${SENTINEL_MASTER_NAME} 127.0.0.1 ${String(master)} 1
sentinel down-after-milliseconds ${SENTINEL_MASTER_NAME} ${String(SENTINEL_DOWN_AFTER_MS)}
sentinel failover-timeout ${SENTINEL_MASTER_NAME} ${String(SENTINEL_FAILOVER_TIMEOUT_MS)}
EOF
    redis-sentinel /tmp/sentinel.conf &
    until redis-cli -p ${String(sentinel)} sentinel get-master-addr-by-name ${SENTINEL_MASTER_NAME} 2>/dev/null | grep -q 127.0.0.1; do sleep 0.1; done
    redis-cli -p ${String(sentinel)} sentinel debug info-period ${String(SENTINEL_INFO_PERIOD_MS)} publish-period ${String(SENTINEL_PUBLISH_PERIOD_MS)} | grep -q OK
    ${discovered}
    echo "${READY}"
    wait
  `,
    };
  });

  return {
    topology: { ...topology, nodes: topology.nodes.filter((node) => node.port === sentinel) },
    sentinel,
  };
}

/**
 * A real master watched by one sentinel, with no replica and so no failover: what this proves
 * is that a Sentinel client resolves the master and carries the Transport's commands to it.
 */
export async function startSentinelTopology(): Promise<RunningTopology> {
  const { topology } = await startSentinel(0);

  return topology;
}

/**
 * The same master and sentinel with one replica beside it, and the two ways the master under a
 * running reader can be replaced: handed over (`promote`, #79) or taken away (`kill`, #81).
 *
 * A separate entry point for the same reason as the cluster's: the files that never fail over
 * start two servers rather than three.
 */
export async function startSentinelFailoverTopology(): Promise<KillableTopology> {
  const { topology, sentinel } = await startSentinel(1);

  return {
    ...topology,
    promote: () => promoteInSentinel(sentinel),
    kill: (key) => killInSentinel(sentinel, key),
  };
}

/** One command on one node of a topology, on a connection opened and closed for the batch. */
type Ask = (port: number, args: string[]) => Promise<unknown>;

/**
 * Talk to the nodes of a topology directly, as an operator would rather than as the Transport
 * does: one plain client per node, all closed again when the caller is done. Every node is
 * reachable at `127.0.0.1:<port>` by construction (see `startTopology`).
 */
async function onNodes<T>(run: (ask: Ask) => Promise<T>): Promise<T> {
  const clients = new Map<number, ReturnType<typeof createClient>>();

  try {
    return await run(async (port, args) => {
      let client = clients.get(port);
      if (client === undefined) {
        client = createClient({ socket: { host: "127.0.0.1", port } });
        client.on("error", () => undefined);
        await client.connect();
        clients.set(port, client);
      }

      return client.sendCommand(args);
    });
  } finally {
    for (const client of clients.values()) client.destroy();
  }
}

/**
 * Wait for something the topology has to report, and never for a duration: `look` answers
 * `undefined` once the thing has landed, and otherwise what it saw — which is what the failure
 * says when the bound runs out, so that a promotion that did not land is a readable test
 * failure rather than a timeout.
 */
async function until(what: string, look: () => Promise<string | undefined>): Promise<void> {
  const deadline = Date.now() + PROMOTION_TIMEOUT_MS;
  let last = "nothing yet";

  while (Date.now() < deadline) {
    const seen = await look();
    if (seen === undefined) return;
    last = seen;
    await new Promise((resolve) => setTimeout(resolve, PROMOTION_POLL_MS));
  }

  throw new Error(
    `${what} did not happen within ${String(PROMOTION_TIMEOUT_MS)}ms; last saw: ${last}`,
  );
}

/** One node as `CLUSTER NODES` describes it, in the fields a promotion is decided on. */
interface ClusterNode {
  id: string;
  port: number;
  master: boolean;
  follows: string | undefined;
  slots: { from: number; to: number }[];
}

/**
 * `CLUSTER NODES`, parsed: `<id> <ip:port@bus> <flags> <master> <ping> <pong> <epoch> <link>
 * <slots...>`. Slot fields naming a migration (`[<slot>-><-<id>]`) are not ownership and are
 * skipped.
 */
function clusterNodesOf(reply: unknown): ClusterNode[] {
  return String(reply)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const fields = line.trim().split(" ");
      const [id = "", address = "", flags = "", follows = "-"] = fields;
      const port = Number(address.split("@")[0]?.split(":").pop());
      const slots = fields.slice(8).flatMap((field) => {
        if (field.startsWith("[")) return [];
        const [from, to = from] = field.split("-").map(Number);

        return from === undefined || to === undefined ? [] : [{ from, to }];
      });

      return {
        id,
        port,
        master: flags.split(",").includes("master"),
        follows: follows === "-" ? undefined : follows,
        slots,
      };
    });
}

/** Whether this node is the master of the slot, as the node whose view this is sees it. */
function ownsSlot(node: ClusterNode, slot: number): boolean {
  return node.master && node.slots.some(({ from, to }) => slot >= from && slot <= to);
}

/**
 * Promote the replica of the master that serves `key`, on a cluster: ask any node which slot
 * the key falls in and who owns it, tell that master's replica to take over, and wait until
 * **every** node of the cluster names the replica as the slot's master.
 *
 * Waiting for all of them rather than for the promoted node alone is what makes the case
 * deterministic: a client that rediscovers the topology from any node then learns the same
 * thing, whichever node it asks.
 */
async function promoteInCluster(
  nodes: { host: string; port: number }[],
  key: string,
): Promise<void> {
  await onNodes(async (ask) => {
    const [first] = nodes;
    if (first === undefined) throw new Error("this topology has no node to ask");

    const slot = Number(await ask(first.port, ["CLUSTER", "KEYSLOT", key]));
    const known = clusterNodesOf(await ask(first.port, ["CLUSTER", "NODES"]));
    const owner = known.find((node) => ownsSlot(node, slot));
    if (owner === undefined) throw new Error(`no master owns slot ${String(slot)}`);

    const replica = known.find((node) => node.follows === owner.id);
    if (replica === undefined) {
      throw new Error(`the master of slot ${String(slot)} has no replica to promote`);
    }

    await ask(replica.port, ["CLUSTER", "FAILOVER"]);

    await until(`the promotion of ${String(replica.port)} for slot ${String(slot)}`, async () => {
      const views = await Promise.all(
        nodes.map(async (node) => ({
          asked: node.port,
          sees: clusterNodesOf(await ask(node.port, ["CLUSTER", "NODES"])).find((seen) =>
            ownsSlot(seen, slot),
          )?.port,
        })),
      );
      const behind = views.filter((view) => view.sees !== replica.port);

      return behind.length === 0
        ? undefined
        : behind
            .map((view) => `${String(view.asked)} still sees ${String(view.sees ?? "nobody")}`)
            .join(", ");
    });
  });
}

/** The port the sentinel names as the master right now, which is where a client is sent. */
async function namedMaster(ask: Ask, sentinel: number): Promise<number> {
  const address = (await ask(sentinel, [
    "SENTINEL",
    "GET-MASTER-ADDR-BY-NAME",
    SENTINEL_MASTER_NAME,
  ])) as string[];

  return Number(address[1]);
}

/**
 * Promote the replica on a Sentinel topology: tell the sentinel to fail over, and wait until it
 * answers a different address for the master, the server at that address says it is one, **and**
 * the server it replaces says it is now a connected replica of it.
 *
 * All three matter, and the last one is not belt and braces: the sentinel publishes the switch
 * before it has reconfigured the old master, and until it has, that server still answers writes.
 * A caller that Published in that window could have it accepted by a node that is about to be
 * told to replicate from someone else — and to throw away what it holds of its own — which is a
 * case passing on a Message the canonical log never received.
 *
 * The last of the three is the slow one, and what it waits for is the sentinel's own `INFO`
 * round rather than the handover (#86) — which is why this topology shortens that round (see
 * `SENTINEL_INFO_PERIOD_MS`) instead of giving the wait a larger number.
 */
async function promoteInSentinel(sentinel: number): Promise<void> {
  await onNodes(async (ask) => {
    const before = await namedMaster(ask, sentinel);
    await ask(sentinel, ["SENTINEL", "FAILOVER", SENTINEL_MASTER_NAME]);

    await until(`the promotion of the replica of ${String(before)}`, async () => {
      const now = await namedMaster(ask, sentinel);
      if (now === before) return `the sentinel still names ${String(before)}`;

      const promoted = (await ask(now, ["ROLE"])) as unknown[];
      if (promoted[0] !== "master") {
        return `${String(now)} is named but reports ${String(promoted[0])}`;
      }

      /**
       * `ROLE` on a replica answers its role, the master it follows and the state of that link:
       * anything but `slave` of the promoted node, connected, still leaves the old master
       * writable on its own account.
       */
      const demoted = (await ask(before, ["ROLE"])) as unknown[];

      return demoted[0] === "slave" && Number(demoted[2]) === now && demoted[3] === "connected"
        ? undefined
        : `${String(before)} still reports ${JSON.stringify(demoted.slice(0, 4))}`;
    });
  });
}

/**
 * Take the master away on a Sentinel topology, the way a node is actually lost in production:
 * `SHUTDOWN NOSAVE` on the server the sentinel currently names, with no handover of any kind,
 * then the same bounded wait until the sentinel names a *different* node and that node reports
 * it is a master.
 *
 * Two things are established before the kill, and neither is politeness:
 *
 * 1. **The reader is on the doomed node.** The case this stages is a blocking `XREAD` losing
 *    the ground under it, so the kill is held until that node's `CLIENT LIST` actually shows a
 *    blocked `xread` — otherwise a slow subscribe would turn the case into a test of a reader
 *    that connects *after* the failover, which is a different, easier path. `CLIENT LIST` names
 *    the command and not its arguments, so what is matched is `cmd=xread`; on this topology,
 *    started for one case, that is this case's reader.
 * 2. **The replica has caught up.** `SHUTDOWN NOSAVE` on a master destroys whatever it had not
 *    yet replicated, so without `WAIT` the case would intermittently be observing Redis's
 *    asynchronous replication losing an Entry — a real property, but a different subject, and a
 *    non-deterministic one. `WAIT 1` makes the promoted node's log a superset of what the
 *    reader has already seen, so what is left to observe is the failover itself. It is bounded
 *    and not absorbed: a `WAIT` that runs out means a topology that is not replicating, and it
 *    throws rather than kills anyway.
 *
 *    The write just before it is what makes that true, and it is not decoration: `WAIT` waits
 *    for the replication offset of **this connection's own** writes, not for the master's
 *    current one. Measured on a master whose replica was frozen: `WAIT 1` on a connection that
 *    had only read answered `1` in 4 ms, while the same `WAIT` on a connection that had written
 *    blocked for 3.4 s until the acknowledgement. This connection has read only — so it writes
 *    one throwaway key first, which puts its offset past everything the case published, and
 *    `WAIT` then means what it is here to mean.
 *
 * The kill command itself is expected to fail: a server that is shutting down answers nothing
 * and closes the socket, which is precisely the acknowledgement wanted.
 */
async function killInSentinel(sentinel: number, key: string): Promise<number> {
  return onNodes(async (ask) => {
    const doomed = await namedMaster(ask, sentinel);

    await until(`a blocked reader of ${key} on the master ${String(doomed)}`, async () => {
      const clients = String(await ask(doomed, ["CLIENT", "LIST"]));

      return clients.includes("cmd=xread") ? undefined : "no client on it is blocked in xread";
    });

    await ask(doomed, ["SET", REPLICATION_PROBE_KEY, String(Date.now())]);
    const replicated = Number(await ask(doomed, ["WAIT", "1", String(REPLICATION_CATCHUP_MS)]));
    if (replicated < 1) {
      throw new Error(
        `no replica of ${String(doomed)} acknowledged its writes within ` +
          `${String(REPLICATION_CATCHUP_MS)}ms; killing it would lose them`,
      );
    }

    await ask(doomed, ["SHUTDOWN", "NOSAVE"]).catch(() => undefined);
    const killedAt = Date.now();

    await until(`the promotion of a replica of the killed ${String(doomed)}`, async () => {
      const now = await namedMaster(ask, sentinel);
      if (now === doomed) return `the sentinel still names ${String(doomed)}`;

      const promoted = (await ask(now, ["ROLE"])) as unknown[];

      return promoted[0] === "master"
        ? undefined
        : `${String(now)} is named but reports ${String(promoted[0])}`;
    });

    return killedAt;
  });
}
