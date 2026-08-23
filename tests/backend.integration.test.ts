import { connect } from "node:net";
import { once } from "node:events";

import { expect, inject, test } from "vitest";

/**
 * The placeholder the integration project stands on until the Transport contract lands: it
 * proves the whole Docker-backed path the gate depends on — testcontainers starts the server,
 * the global setup hands its URL to the workers, and the server answers on it.
 */
test("the backend the integration project was given answers PING", async () => {
  const { hostname, port } = new URL(inject("redisUrl"));
  const socket = connect({ host: hostname, port: Number(port) });

  try {
    await once(socket, "connect");
    socket.write("PING\r\n");
    const [reply] = (await once(socket, "data")) as [Buffer];

    expect(reply.toString()).toBe("+PONG\r\n");
  } finally {
    socket.destroy();
  }
});
