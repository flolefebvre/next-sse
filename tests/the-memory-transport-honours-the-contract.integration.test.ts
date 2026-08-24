import { transportContract } from "../packages/next-sse/src/testing/index.js";
import { createMemoryTransport } from "../packages/next-sse/src/transport/memory.js";

/**
 * The shipped single-Instance Transport, put through the very suite a third party runs against
 * their own log (ADR-0009). It supplies no backend hooks: it is one in-process log, so it can
 * neither stage an outage nor hold a second Instance, and the cases that need those are skipped
 * in the report rather than quietly left out.
 */
transportContract({
  create: ({ retention }) => createMemoryTransport({ retention }),
});
