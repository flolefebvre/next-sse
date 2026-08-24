import { transportContract } from "@flefebvre/next-sse/testing";

import { createArrayLogTransport } from "./transport";

/**
 * The custom Transport of this App, held to the same suite the library holds its own to.
 *
 * `transportContract` is exported from `@flefebvre/next-sse/testing` for exactly this: a
 * Transport is a set of obligations — ordering, paging strictly after a Cursor, an honest
 * `gone`, a live feed that starts where it says it does, retention — and the suite is what
 * turns them from prose into a run. Anyone writing a Transport of their own writes these four
 * lines and finds out.
 *
 * `create` is handed the Retention each case wants and must answer a log with nothing in it: a
 * case assumes the only Entries it will read are the ones it published. Neither optional hook
 * is given — `outage` and `peer` are for a backend that can be cut off and that a second
 * Instance can share, and this log is in this process — so the cases needing them are skipped
 * by name rather than quietly passing, which is the honest report for a Transport that cannot
 * stage what they are about.
 */
transportContract({
  create: ({ retention }) => createArrayLogTransport({ retention }),
});
