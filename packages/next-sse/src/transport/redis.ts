import { notImplemented } from "../internal/not-implemented.js";

/** The multi-Instance Transport: one Redis Stream per App, on Redis or Valkey. */
export function createRedisTransport(options?: unknown): never {
  void options;

  return notImplemented("createRedisTransport");
}

/** The publisher-only half of the Redis Transport, for a process outside Next.js. */
export function createRedisPublisher(options?: unknown): never {
  void options;

  return notImplemented("createRedisPublisher");
}
