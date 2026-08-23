import { expect, test } from "vitest";

import { startInstance } from "./harness/example.js";

/**
 * The placeholder the e2e project stands on until the protocol lands, and the only proof that
 * the example app of the acceptance criteria really builds and starts: one Instance of the
 * built app, serving the page that imports both entry points of the package.
 */
test("an Instance of the built example app serves the page that loads both entry points", async () => {
  const instance = await startInstance();

  try {
    const response = await fetch(instance.url);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("server entry loaded");
    expect(html).toContain("client entry loaded");
  } finally {
    await instance.stop();
  }
});
