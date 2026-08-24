import { createServer, request as forward, type Server } from "node:http";
import type { Socket } from "node:net";

/** One address in front of two Instances, and the Instance it is pointed at. */
export interface Proxy {
  /** Where a client goes: the only address it ever knows (ADR-0009). */
  url: string;
  /** Send everything from now on to this Instance. Nothing already open is touched. */
  sendTo(url: string): void;
  /**
   * Drop every connection it is holding, and go on listening. A pipe dying under a client with
   * nobody telling it anything — the lift, the lost Wi-Fi, the middlebox that idles a stream out
   * — which is the one way a Connection ends that the App never gets to say a word about.
   */
  cut(): void;
  close(): Promise<void>;
}

/**
 * A throwaway load balancer: every request is forwarded to whichever Instance it is currently
 * pointed at, body and answer streamed through as they come.
 *
 * It is what makes failover testable at all. A client that talks to an Instance directly and
 * loses it has nowhere to come back to; a real deployment has one address in front of many
 * pods, and moving that address to the survivor is the whole of a failover — restarting a
 * process on the same port proves something else entirely. Nothing here is a proxy worth
 * keeping: no pooling, no health checks, no rewriting. `agent: false` is the one deliberate
 * choice — a pooled socket to an Instance that has just gone would be handed to the very
 * request meant to escape it.
 */
export async function startProxy(url: string): Promise<Proxy> {
  let upstream = new URL(url);
  const open = new Set<Socket>();

  const server = createServer((incoming, answer) => {
    const forwarded = forward(
      {
        host: upstream.hostname,
        port: upstream.port,
        path: incoming.url,
        method: incoming.method,
        headers: { ...incoming.headers, host: upstream.host },
        agent: false,
      },
      (upstreamAnswer) => {
        answer.writeHead(upstreamAnswer.statusCode ?? 502, upstreamAnswer.headers);
        upstreamAnswer.pipe(answer);
      },
    );

    forwarded.on("error", () => {
      answer.destroy();
    });
    incoming.pipe(forwarded);
  });

  server.on("connection", (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });

  await listen(server);

  const cut = (): void => {
    for (const socket of open) socket.destroy();
    open.clear();
  };

  return {
    url: `http://127.0.0.1:${String(portOf(server))}`,
    sendTo: (next: string) => {
      upstream = new URL(next);
    },
    cut,
    close: async () => {
      cut();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function listen(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

/** The port the kernel gave it, so any number of runs stand side by side. */
function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the proxy did not take a port");
  }

  return address.port;
}
