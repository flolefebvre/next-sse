import { expect, test } from "vitest";

import { transportOptionsFromEnv } from "./env.js";

test("the whole table is read into the options the factories take", () => {
  expect(
    transportOptionsFromEnv({
      REDIS_URL: "redis://localhost:6379",
      NEXT_SSE_PREFIX: "my-app",
      NEXT_SSE_RETENTION_WINDOW: "60",
      NEXT_SSE_RETENTION_CAP: "500",
      NEXT_SSE_OPERATION_TIMEOUT: "250",
      NEXT_SSE_DEBUG: "true",
    }),
  ).toEqual({
    url: "redis://localhost:6379",
    prefix: "my-app",
    retention: { window: 60, cap: 500 },
    operationTimeout: 250,
    debug: true,
  });
});

test("an environment that configures nothing gives no option at all", () => {
  expect(transportOptionsFromEnv({})).toEqual({});
});

/** A deployment tool that materialises an unset variable as `""` must configure nothing. */
test("an empty variable counts as unset", () => {
  expect(
    transportOptionsFromEnv({
      REDIS_URL: "",
      NEXT_SSE_PREFIX: "",
      NEXT_SSE_RETENTION_CAP: "",
      NEXT_SSE_DEBUG: "",
    }),
  ).toEqual({});
});

test("retention is given whenever either of its two variables is", () => {
  expect(transportOptionsFromEnv({ NEXT_SSE_RETENTION_WINDOW: "30" })).toEqual({
    retention: { window: 30 },
  });
  expect(transportOptionsFromEnv({ NEXT_SSE_RETENTION_CAP: "30" })).toEqual({
    retention: { cap: 30 },
  });
});

test("debug takes the four spellings of a boolean, either case", () => {
  expect(transportOptionsFromEnv({ NEXT_SSE_DEBUG: "1" }).debug).toBe(true);
  expect(transportOptionsFromEnv({ NEXT_SSE_DEBUG: "TRUE" }).debug).toBe(true);
  expect(transportOptionsFromEnv({ NEXT_SSE_DEBUG: "0" }).debug).toBe(false);
  expect(transportOptionsFromEnv({ NEXT_SSE_DEBUG: "False" }).debug).toBe(false);
});

test("a value that is no whole number, or no boolean, is refused by name", () => {
  expect(() => transportOptionsFromEnv({ NEXT_SSE_RETENTION_CAP: "lots" })).toThrow(
    /`NEXT_SSE_RETENTION_CAP` must be a whole number, was `lots`/,
  );
  expect(() => transportOptionsFromEnv({ NEXT_SSE_OPERATION_TIMEOUT: "1.5" })).toThrow(
    /`NEXT_SSE_OPERATION_TIMEOUT` must be a whole number/,
  );
  expect(() => transportOptionsFromEnv({ NEXT_SSE_RETENTION_WINDOW: "-1" })).toThrow(
    /`NEXT_SSE_RETENTION_WINDOW` must be a whole number/,
  );
  expect(() => transportOptionsFromEnv({ NEXT_SSE_DEBUG: "yes" })).toThrow(
    /`NEXT_SSE_DEBUG` must be one of/,
  );
});

/**
 * An unusable value must be reported on a host that has no `REDIS_URL` too, rather than lying
 * dormant until the day one is set.
 */
test("every variable is parsed before REDIS_URL is read", () => {
  expect(() => transportOptionsFromEnv({ NEXT_SSE_RETENTION_CAP: "lots" })).toThrow();
});
