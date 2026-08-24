import { cache } from "react";

import { sealSnapshot, type Snapshot } from "../internal/snapshot.js";
import type { Cursor } from "../transport/index.js";

import type { Instance } from "./instance.js";

/** The server-render→live handoff, as the Registry carries it (ADR-0007). */
export interface Handoff {
  /**
   * This request's Cursor: the log's tail, read once however many server components ask for it.
   *
   * An App rarely calls it — `snapshot` is what it reaches for — and it is public because a
   * server component that hands its data over some other way still has to take its position
   * before it reads.
   */
  cursor(): Promise<Cursor>;
  /**
   * Read the data and hand it to the client as one Snapshot, with the Cursor taken _before_ the
   * read.
   *
   * The order is the whole point (ADR-0001): a Message published between the read and the
   * stream going live is after the Cursor, so the Instance replays it and the client sees it
   * exactly once. Taking the Cursor after the read would lose it. Nothing an App writes can get
   * that order wrong, because the App does not write it.
   */
  snapshot<Data>(read: () => Data | Promise<Data>): Promise<Snapshot<Data>>;
}

/**
 * The handoff of one App, bound to its Instance.
 *
 * `cursor` is memoised with React's `cache`, so it is per request: every server component of
 * one render shares one Cursor, and the client therefore reopens its Connection once rather
 * than once per Snapshot on the page (ADR-0007). The memo is per Registry, which is per module
 * evaluation — a re-evaluated `createSSE` makes a new one, and a request is served entirely by
 * one of them.
 */
export function createHandoff(instance: Instance): Handoff {
  const cursor = cache((): Promise<Cursor> => instance.transport.tail());

  return {
    cursor,
    snapshot: async (read) => sealSnapshot(await cursor(), await read()),
  };
}
