import { createServer } from "node:net";

import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

import { testImage } from "./valkey-container.js";

/** The master a Sentinel topology monitors, as both the sentinel and the client name it. */
export const SENTINEL_MASTER_NAME = "mymaster";

/** How long a topology may take to come up: several servers and a cluster handshake. */
const STARTUP_TIMEOUT_MS = 120_000;

/** What the container prints once every server is up and the topology has settled. */
const READY = "TOPOLOGY READY";

/** One running topology, and the way to stop it. */
export interface RunningTopology {
  /** The nodes a client of this topology is pointed at, reachable from this process. */
  nodes: { host: string; port: number }[];
  stop(): Promise<void>;
}

/**
 * Ports nothing is listening on, all held at once and released together, so that the three
 * nodes of a cluster can never be handed the same number twice.
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
 * A real cluster of three masters, every slot covered and no replica: enough for a Transport's
 * commands to be routed by their key to a master that is not the one the client was pointed at,
 * which is the thing a Cluster client is there to do.
 */
export async function startClusterTopology(): Promise<RunningTopology> {
  const ports = await freePorts(3);
  const addresses = ports.map((port) => `127.0.0.1:${String(port)}`).join(" ");

  return startTopology(
    ports,
    `
    set -e
    for port in ${ports.join(" ")}; do
      redis-server --port "$port" --cluster-enabled yes --cluster-config-file "/tmp/node-$port.conf" --cluster-node-timeout 5000 --appendonly no --save '' --dir /tmp &
    done
    for port in ${ports.join(" ")}; do
      until redis-cli -p "$port" ping 2>/dev/null | grep -q PONG; do sleep 0.1; done
    done
    redis-cli --cluster create ${addresses} --cluster-yes
    for port in ${ports.join(" ")}; do
      until redis-cli -p "$port" cluster info | grep -q 'cluster_state:ok'; do sleep 0.1; done
    done
    echo "${READY}"
    wait
  `,
  );
}

/**
 * A real master watched by one sentinel. No replica and no failover: what this proves is that a
 * Sentinel client resolves the master and carries the Transport's commands to it (#57 rules
 * failover out of scope, and a reader that survives one is a separate claim).
 *
 * The nodes it answers are the sentinel's, which is what a Sentinel client is pointed at.
 */
export async function startSentinelTopology(): Promise<RunningTopology> {
  const [master, sentinel] = await freePorts(2);
  if (master === undefined || sentinel === undefined) throw new Error("no free port to take");

  const topology = await startTopology(
    [master, sentinel],
    `
    set -e
    redis-server --port ${String(master)} --appendonly no --save '' --dir /tmp &
    until redis-cli -p ${String(master)} ping 2>/dev/null | grep -q PONG; do sleep 0.1; done
    cat > /tmp/sentinel.conf <<EOF
port ${String(sentinel)}
sentinel monitor ${SENTINEL_MASTER_NAME} 127.0.0.1 ${String(master)} 1
sentinel down-after-milliseconds ${SENTINEL_MASTER_NAME} 1000
sentinel failover-timeout ${SENTINEL_MASTER_NAME} 5000
EOF
    redis-sentinel /tmp/sentinel.conf &
    until redis-cli -p ${String(sentinel)} sentinel get-master-addr-by-name ${SENTINEL_MASTER_NAME} 2>/dev/null | grep -q 127.0.0.1; do sleep 0.1; done
    echo "${READY}"
    wait
  `,
  );

  return { ...topology, nodes: topology.nodes.filter((node) => node.port === sentinel) };
}
