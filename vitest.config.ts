import { configDefaults, defineConfig } from "vitest/config";

const CLIENT_TESTS = ["packages/*/src/**/*.client.test.ts", "packages/*/src/**/*.client.test.tsx"];
const INTEGRATION_TESTS = [
  "packages/*/src/**/*.integration.test.ts",
  "tests/**/*.integration.test.ts",
];
const E2E_TESTS = ["e2e/**/*.e2e.test.ts"];

/**
 * The example app's own tests: the two patterns whose subject is a test — testing your App, and
 * a Transport of your own held to the contract. They are consumer code, so they resolve
 * `@flefebvre/next-sse` through the exports map against the built `dist`, which puts them in
 * the post-build phase with `e2e` and nowhere else (ADR-0009).
 */
const EXAMPLE_TESTS = ["examples/*/**/*.test.ts", "examples/*/**/*.test.tsx"];

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
        /**
         * The App's own path alias, which its `tsconfig.json` declares and Next.js honours.
         * Vitest reads no `tsconfig` paths, so the one the example uses is restated here — the
         * alternative would be an example whose imports are written for the test runner rather
         * than for the App.
         */
        resolve: {
          alias: { "@/": new URL("./examples/basic/", import.meta.url).pathname },
        },
        test: {
          name: "example",
          environment: "jsdom",
          include: EXAMPLE_TESTS,
          clearMocks: true,
          restoreMocks: true,
          sequence: { groupOrder: 2 },
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
