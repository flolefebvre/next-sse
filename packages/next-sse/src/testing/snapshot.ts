import { sealSnapshot, type Snapshot } from "../internal/snapshot.js";
import type { Cursor } from "../transport/index.js";

/**
 * A Snapshot for a test, minted the way the server mints one.
 *
 * A Snapshot is opaque by type (ADR-0007): `sse.snapshot(read)` is the only thing that makes
 * one, and nothing outside the library can read the Cursor inside it. That is exactly what a
 * component test cannot do — it renders a Client Component in isolation, with no App and no
 * server render above it, and still has to hand the hook the value a page would have handed
 * it. Without this, every consumer's suite would open the type with a cast, which is the one
 * thing the opacity exists to prevent.
 *
 * It seals through the very function the server half uses, so what a test renders is what a
 * page renders, and the two cannot drift apart.
 *
 * ```ts
 * const snapshot = snapshotOf([{ id: "1", text: "rendered on the server" }], "cursor-0");
 * render(<Messages roomId="42" snapshot={snapshot} />);
 * ```
 *
 * The Cursor is required, because a Snapshot always carries one: it is the position the read
 * was taken at, and a hook spends it by reopening the Channel from there. Any string will do —
 * it is opaque to everything above the Transport — and a test that drives a `FakeEventSource`
 * reads it back off the Connection's URL to assert the resume happened.
 *
 * Test-only: it is in `./testing` and nowhere else, and an App has no use for it. Minting a
 * Snapshot around data in production code would be claiming a position the log never gave.
 */
export function snapshotOf<Data>(data: Data, cursor: Cursor): Snapshot<Data> {
  return sealSnapshot(cursor, data);
}
