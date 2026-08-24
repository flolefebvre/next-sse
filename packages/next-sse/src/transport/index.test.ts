import { expect, test } from "vitest";

import { TransportClosedError, TransportError, TransportUnavailableError } from "./index.js";

/**
 * Every failure a Transport reports names itself. It is one line of behaviour and it is worth a
 * case: a subclass of `Error` that sets no `name` is printed as `Error` by every logger and test
 * runner there is, so the taxonomy an App catches on becomes invisible to whoever has to read
 * the failure — which is how `Error: Socket closed unexpectedly` cost a triage its first hour
 * (#86).
 */
test.each([
  ["TransportError", new TransportError("nope")],
  ["TransportUnavailableError", new TransportUnavailableError("nope")],
  ["TransportClosedError", new TransportClosedError("nope")],
])("a %s says what kind of failure it is", (name, error) => {
  expect(error.name).toBe(name);
  expect(String(error)).toBe(`${name}: nope`);
});
