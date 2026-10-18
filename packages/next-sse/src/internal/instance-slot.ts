/**
 * Where the Instance lives. A `Symbol.for` slot on `globalThis` costs nothing in production
 * and is what keeps one Transport, one Connection table and one Registry across the module
 * re-evaluations Turbopack does on every request after an edit (ADR-0004): without it a
 * Publish from the new module instance would never reach a Connection held by the old one.
 *
 * It is defined here, once, because two entries read it: `./server`, which builds the Instance
 * into it, and `./testing`, whose `recordPublishes()` finds that Instance without importing the
 * server graph — a second literal copy of the key would be free to drift from the first.
 */
export const INSTANCE_SLOT = Symbol.for("@flefebvre/next-sse");
