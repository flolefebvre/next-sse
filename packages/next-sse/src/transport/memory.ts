import { notImplemented } from "../internal/not-implemented.js";

/** The single-Instance Transport: one bounded in-process log, no backend at all. */
export function createMemoryTransport(options?: unknown): never {
  void options;

  return notImplemented("createMemoryTransport");
}
