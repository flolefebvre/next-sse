import type { Cursor } from "../transport/index.js";

declare const cursor: unique symbol;

/**
 * The one value a server component hands the client to make server-rendered data live: the
 * data it read, and the Cursor taken just before that read (ADR-0007).
 *
 * It is a plain, serialisable object — it crosses the RSC boundary as a prop, so it can be
 * nothing else — and it is opaque by type: the brand is the only place the Cursor is named,
 * and nothing outside this module can read it. That is what enforces ADR-0001's ordering rule
 * as an API rather than as a paragraph: `sse.snapshot(read)` is the only way to mint one, and
 * a hook is the only way to spend one, so the word "cursor" never has to appear in App code.
 */
export type Snapshot<Data = unknown> = {
  readonly data: Data;
  readonly [cursor]: true;
};

/** A Snapshot as the two ends of the library see it, which is the shape it really has. */
interface Sealed {
  readonly data: unknown;
  readonly cursor: Cursor;
}

/** The Snapshot for this data, taken at this Cursor. The server half's only way to make one. */
export function sealSnapshot<Data>(cursorTaken: Cursor, data: Data): Snapshot<Data> {
  const sealed: Sealed = { data, cursor: cursorTaken };

  return sealed as unknown as Snapshot<Data>;
}

/** The Cursor inside a Snapshot. The client half's only way to read one, and it never shows it. */
export function cursorOf(snapshot: Snapshot): Cursor {
  return (snapshot as unknown as Sealed).cursor;
}
