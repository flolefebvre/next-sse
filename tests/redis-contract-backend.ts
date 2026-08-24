import { randomUUID } from "node:crypto";

import type { TransportContractOptions } from "../packages/next-sse/src/testing/index.js";
import type { Retention, Transport } from "../packages/next-sse/src/transport/index.js";
import { createRedisTransport } from "../packages/next-sse/src/transport/redis.js";

import { startTcpProxy, type TcpProxy } from "./tcp-proxy.js";

/** What the contract suite is run with here, and what has to be cleaned up after it. */
export interface RedisContractBackend {
  options: TransportContractOptions;
  /** Close the proxies the run opened. The suite closes the Transports itself. */
  close(): Promise<void>;
}

/** What one Transport of this run was opened on: its log, and how much of it is kept. */
interface OpenedOn {
  prefix: string;
  retention: Retention;
  proxy: TcpProxy;
}

/**
 * The contract suite's view of one real server: every Transport on a log of its own, a peer on
 * the same log, and an outage that is that Transport's alone.
 *
 * Isolation is a fresh Prefix per `create`, which is what the suite requires of a factory
 * sharing one backend: every case assumes the log holds nothing but what it published, and one
 * container serves the whole run.
 *
 * Every Transport gets its own proxy in front of the server — the peer included — so cutting
 * one leaves the other publishing and trimming, which is the only way a gap can be staged. A
 * peer is opened on the log it is a peer of, retention and all: how much of the log is kept is
 * the log's property, and the cases that trim through a peer depend on it.
 */
export function redisContractBackend(url: () => string): RedisContractBackend {
  const proxies = new Set<TcpProxy>();
  const opened = new Map<Transport, OpenedOn>();

  const open = async (prefix: string, retention: Retention): Promise<Transport> => {
    const proxy = await startTcpProxy(url());
    proxies.add(proxy);

    const transport = createRedisTransport({ url: proxy.url, prefix, retention });
    opened.set(transport, { prefix, retention, proxy });

    return transport;
  };

  const openedOn = (transport: Transport): OpenedOn => {
    const on = opened.get(transport);
    if (on === undefined) throw new Error("that Transport did not come from this backend");

    return on;
  };

  return {
    options: {
      create: ({ retention }) => open(`next-sse-test-${randomUUID().slice(0, 8)}`, retention),
      backend: {
        peer: async (transport) => {
          const on = openedOn(transport);

          return open(on.prefix, on.retention);
        },
        outage: {
          begin: async (transport) => openedOn(transport).proxy.cut(),
          end: async (transport) => openedOn(transport).proxy.restore(),
        },
      },
    },
    close: async () => {
      for (const proxy of proxies) await proxy.close();
      proxies.clear();
      opened.clear();
    },
  };
}
