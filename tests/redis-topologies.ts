import { createServer } from "node:net";

import { createClient } from "redis";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

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
 */
const PROMOTION_TIMEOUT_MS = 30_000;

/** How often the readiness of a promotion is re-read while it is being waited for. */
const PROMOTION_POLL_MS = 100;

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
 * The image is whatever `testImage()` names, unchanged: the official Valkey image ships
 * `redis-server`, `redis-cli` and `redis-sentinel` compatibility names, so one script drives
 * both cells of the CI matrix.
 */
async function startTopology(ports: number[], script: string): Promise<RunningTopology> {
  const container: StartedTestContainer = await new GenericContainer(testImage())
    .withExposedPorts(...ports.map((port) => ({ container: port, host: port })))
    .withCommand(["sh", "-c", script])
    .withWaitStrategy(Wait.forLogMessage(READY))
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();

  return {
    nodes: ports.map((port) => ({ host: "127.0.0.1", port })),
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * A real cluster of three masters, every slot covered, with `replicas` replicas of each: the
 * shape a Transport's commands are routed by their key on, and — with a replica — the shape a
 * slot's master can move on.
 */
async function startCluster(replicas: number): Promise<RunningTopology> {
  const nodes = await clusterNodes(3 * (1 + replicas));
  const ports = nodes.map((node) => node.client);
  const addresses = ports.map((port) => `127.0.0.1:${String(port)}`).join(" ");
  const servers = nodes
    .map(
      ({ client, bus }) =>
        `redis-server --port ${String(client)} --cluster-port ${String(bus)} --cluster-enabled yes --cluster-config-file "/tmp/node-${String(client)}.conf" --cluster-node-timeout 5000 --appendonly no --save '' --dir /tmp &`,
    )
    .join("\n    ");

  return startTopology(
    ports,
    `
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
  );
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

  const topology = await startTopology(
    ports,
    `
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
sentinel down-after-milliseconds ${SENTINEL_MASTER_NAME} 1000
sentinel failover-timeout ${SENTINEL_MASTER_NAME} 5000
EOF
    redis-sentinel /tmp/sentinel.conf &
    until redis-cli -p ${String(sentinel)} sentinel get-master-addr-by-name ${SENTINEL_MASTER_NAME} 2>/dev/null | grep -q 127.0.0.1; do sleep 0.1; done
    ${discovered}
    echo "${READY}"
    wait
  `,
  );

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
 * The same master and sentinel with one replica beside it, and the way to promote it (#79):
 * the shape on which the master a Sentinel client resolved can be replaced under a running
 * reader.
 *
 * A separate entry point for the same reason as the cluster's: the files that never fail over
 * start two servers rather than three.
 */
export async function startSentinelFailoverTopology(): Promise<FailoverTopology> {
  const { topology, sentinel } = await startSentinel(1);

  return {
    ...topology,
    promote: () => promoteInSentinel(sentinel),
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

/**
 * Promote the replica on a Sentinel topology: tell the sentinel to fail over, and wait until it
 * answers a different address for the master **and** the server at that address says it is one.
 *
 * Both halves matter: the sentinel publishes the switch before the promoted server has finished
 * taking the role, and a client that reconnects in between would be sent to a replica.
 */
async function promoteInSentinel(sentinel: number): Promise<void> {
  await onNodes(async (ask) => {
    const address = async (): Promise<number> =>
      Number(
        (
          (await ask(sentinel, [
            "SENTINEL",
            "GET-MASTER-ADDR-BY-NAME",
            SENTINEL_MASTER_NAME,
          ])) as string[]
        )[1],
      );

    const before = await address();
    await ask(sentinel, ["SENTINEL", "FAILOVER", SENTINEL_MASTER_NAME]);

    await until(`the promotion of the replica of ${String(before)}`, async () => {
      const now = await address();
      if (now === before) return `the sentinel still names ${String(before)}`;

      const role = (await ask(now, ["ROLE"])) as unknown[];

      return role[0] === "master"
        ? undefined
        : `${String(now)} is named but reports ${String(role[0])}`;
    });
  });
}
