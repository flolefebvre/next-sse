import { expect, test } from "vitest";

import { DeadlineError, withDeadline } from "./deadline.js";

test("an operation that finishes in time gives back what it produced", async () => {
  await expect(withDeadline(1000, async () => "done")).resolves.toBe("done");
});

test("an operation's own failure is what surfaces, not the deadline", async () => {
  await expect(
    withDeadline(1000, () => Promise.reject(new Error("the backend said no"))),
  ).rejects.toThrow("the backend said no");
});

test("an operation that never settles fails on its deadline, naming it", async () => {
  await expect(withDeadline(10, () => new Promise(() => undefined))).rejects.toBeInstanceOf(
    DeadlineError,
  );
});

/** Nothing is cancelled: what ran past its deadline runs on, and its result is dropped. */
test("the operation is not cancelled, only stopped being waited on", async () => {
  let finished = false;
  const operation = new Promise((resolve) =>
    setTimeout(() => {
      finished = true;
      resolve("late");
    }, 20),
  );

  await expect(withDeadline(5, () => operation)).rejects.toBeInstanceOf(DeadlineError);
  await operation;
  expect(finished).toBe(true);
});
