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

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
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
          /**
           * Last of all, and in a group of its own: two projects sharing a group must agree on
           * their worker count, and this one runs one file at a time where `example` does not.
           */
          sequence: { groupOrder: 3 },
        },
      },
    ],
  },
});
