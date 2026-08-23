import { notImplemented } from "../internal/not-implemented.js";

/**
 * The App's single entry into the library: it takes every piece of configuration (ADR-0008)
 * and returns the factory the Registry is declared with.
 */
export function initSSE(options?: unknown): never {
  void options;

  return notImplemented("initSSE");
}

/**
 * The Server Component that shares the Registry's Channel data with the client tree.
 */
export function SSEProvider(props?: unknown): never {
  void props;

  return notImplemented("SSEProvider");
}

/**
 * The serialisable Channel data of a Registry, for an App that composes `SSEClientProvider`
 * itself rather than mounting `SSEProvider`.
 */
export function toClientChannels(sse?: unknown): never {
  void sse;

  return notImplemented("toClientChannels");
}
