import { createServer } from "node:net";

/**
 * A host port nothing is listening on, taken by binding one and letting it go. Every Instance
 * of a run gets one of these, so two runs on one machine never collide.
 */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));

  return port;
}
