import { createClient } from "redis";
import { expect, inject, test } from "vitest";

/**
 * The placeholder the integration project stands on until the Transport contract lands: it
 * proves the whole Docker-backed path the gate depends on — testcontainers starts the server,
 * the global setup hands its URL to the workers, and the server answers on it.
 *
 * The connection goes through node-redis rather than a raw socket, so a URL supplied by
 * `NEXT_SSE_TEST_REDIS_URL` is honoured whole: default port, credentials and `rediss:` TLS
 * included.
 */
test("the backend the integration project was given answers PING", async () => {
  const client = createClient({ url: inject("redisUrl") });
  client.on("error", () => undefined);
  await client.connect();

  try {
    await expect(client.ping()).resolves.toBe("PONG");
  } finally {
    await client.close();
  }
});
