import { expect, test } from "vitest";

/**
 * The module the `./server` entry resolves to under every condition but `react-server`. A
 * Client Component that imports the App's Registry must fail at module load, so the failure
 * is asserted here on the module itself; that the exports map really routes to it is asserted
 * against the built package by `pack:check`.
 */
test("importing the server entry outside the react-server condition throws at module load", async () => {
  await expect(import("./outside-react-server.js")).rejects.toThrow(/react-server/);
});
