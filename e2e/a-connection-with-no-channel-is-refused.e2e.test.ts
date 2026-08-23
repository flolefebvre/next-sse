import { expect, test } from "vitest";

import { startInstance } from "./harness/example.js";

/**
 * The one failure the route answers before anything is opened: a Connection that names no
 * Channel is a `400`, not a stream that carries nothing.
 */
test("a Connection with no Channel is refused", async () => {
  const instance = await startInstance();

  try {
    const response = await fetch(`${instance.url}/api/sse`);

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
  } finally {
    await instance.stop();
  }
});
