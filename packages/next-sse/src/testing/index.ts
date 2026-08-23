import { notImplemented } from "../internal/not-implemented.js";

/**
 * The Vitest-bound contract suite every Transport owes: run it against your own factory and
 * the log obligation is verified the way the shipped Transports are.
 */
export function transportContract(options?: unknown): never {
  void options;

  return notImplemented("transportContract");
}

/**
 * The `EventSource`-shaped double the library's own client tests run on, shipped so that a
 * consumer tests their components the same way.
 */
export function FakeEventSource(url?: unknown): never {
  void url;

  return notImplemented("FakeEventSource");
}
