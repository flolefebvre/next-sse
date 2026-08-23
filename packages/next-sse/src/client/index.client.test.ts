import { expect, test } from "vitest";

import { createClient } from "./index.js";

/**
 * The placeholder the `client` project stands on until the hooks land: it proves the project
 * runs in jsdom and that the client entry — the one a browser bundle loads, with no
 * `react-server` condition in sight — imports cleanly.
 */
test("the client entry loads in a browser-shaped environment", () => {
  expect(typeof document).toBe("object");
  expect(() => createClient()).toThrow(/not implemented/);
});
