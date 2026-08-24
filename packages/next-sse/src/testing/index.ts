import { notImplemented } from "../internal/not-implemented.js";

export { transportContract } from "./transport-contract.js";
export type { TransportBackend, TransportContractOptions } from "./transport-contract.js";

/**
 * The `EventSource`-shaped double the library's own client tests run on, shipped so that a
 * consumer tests their components the same way.
 */
export function FakeEventSource(url?: unknown): never {
  void url;

  return notImplemented("FakeEventSource");
}
