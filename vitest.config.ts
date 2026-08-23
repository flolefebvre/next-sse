import { configDefaults, defineConfig } from "vitest/config";

const CLIENT_TESTS = ["packages/*/src/**/*.client.test.ts", "packages/*/src/**/*.client.test.tsx"];
const INTEGRATION_TESTS = [
  "packages/*/src/**/*.integration.test.ts",
  "tests/**/*.integration.test.ts",
];
const E2E_TESTS = ["e2e/**/*.e2e.test.ts"];

/**
 * The condition every server module of the package is written under, so that a test loading
 * one resolves the same files Next.js does in a Server Component. The `client` project is
 * the deliberate exception (ADR-0009): it must resolve as a browser bundle does.
 */
const REACT_SERVER = { conditions: ["react-server"] };

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        resolve: REACT_SERVER,
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...CLIENT_TESTS, ...INTEGRATION_TESTS, ...E2E_TESTS],
          clearMocks: true,
          restoreMocks: true,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "client",
          environment: "jsdom",
          include: CLIENT_TESTS,
          clearMocks: true,
          restoreMocks: true,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        resolve: REACT_SERVER,
        test: {
          name: "integration",
          environment: "node",
          include: INTEGRATION_TESTS,
          globalSetup: ["tests/global-setup.ts"],
          pool: "forks",
          isolate: true,
          hookTimeout: 120_000,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        resolve: REACT_SERVER,
        test: {
          name: "e2e",
          environment: "node",
          include: E2E_TESTS,
          globalSetup: ["e2e/global-setup.ts"],
          pool: "forks",
          isolate: true,
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 300_000,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
