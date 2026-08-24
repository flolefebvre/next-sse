import net from "node:net";

/**
 * A cuttable path to the backend: one Transport connects through it, and cutting it takes that
 * Transport off the server while everything else goes on talking to it.
 *
 * It is what makes `backend.outage` per-Transport rather than per-backend (ADR-0009's contract
 * suite): the positive `onGap` case needs one Transport cut off while a peer keeps publishing
 * and the log trims past the position the cut one would resume from, which pausing the
 * container cannot stage.
 */
export interface TcpProxy {
  /** The URL to give the Transport: the target's, with this proxy's address in it. */
  url: string;
  /** Take the Transport off the server: live connections are dropped, new ones refused. */
  cut(): void;
  /** Let it back on. */
  restore(): void;
  close(): Promise<void>;
}

const DEFAULT_REDIS_PORT = 6379;

/**
 * Start one proxy in front of a server. It listens on a port of the kernel's choosing, so any
 * number of them run side by side, and it is unref'd: a run that ends with one still open is
 * not held up by it.
 *
 * A cut is a reset rather than a black hole on purpose: an operation must fail while the
 * backend is away, promptly and unretried, which is exactly what the contract suite asserts.
 */
export async function startTcpProxy(targetUrl: string): Promise<TcpProxy> {
  const target = new URL(targetUrl);
  const host = target.hostname;
  const port = Number(target.port === "" ? DEFAULT_REDIS_PORT : target.port);

  const open = new Set<net.Socket>();
  let cut = false;

  const server = net.createServer((incoming) => {
    if (cut) {
      incoming.destroy();

      return;
    }

    const outgoing = net.connect({ host, port });
    open.add(incoming);
    open.add(outgoing);

    const drop = (): void => {
      open.delete(incoming);
      open.delete(outgoing);
      incoming.destroy();
      outgoing.destroy();
    };

    incoming.on("error", drop);
    outgoing.on("error", drop);
    incoming.on("close", drop);
    outgoing.on("close", drop);
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the proxy did not take a port");
  }

  const url = new URL(targetUrl);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);

  return {
    url: url.toString(),
    cut: () => {
      cut = true;
      for (const socket of open) socket.destroy();
      open.clear();
    },
    restore: () => {
      cut = false;
    },
    close: async () => {
      cut = true;
      for (const socket of open) socket.destroy();
      open.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
