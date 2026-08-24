import { notImplemented } from "../internal/not-implemented.js";

/**
 * The opaque, Transport-minted position in an App's Message flow. Its format belongs to the
 * Transport that minted it (ADR-0001) and everything above compares it by equality only.
 */
export type Cursor = string;

/** One item in a Transport's log: the wire envelope of ADR-0006, round-tripped as JSON. */
export type Entry =
  | { readonly v: 1; readonly type: "message"; channel: string; event: string; payload: unknown }
  | { readonly v: 1; readonly type: "control"; control: "kick"; key?: string; channel?: string };

/**
 * An Entry as it comes back out of the log: the envelope that was published, plus the Cursor
 * the Transport minted for it. The Cursor is not part of the stored JSON (ADR-0006's envelope
 * is what an external publisher writes, and it has none); the Transport attaches it on the way
 * out, from the position it already holds.
 */
export type StoredEntry = Entry & { readonly cursor: Cursor };

/** What one page of a `read` answers: Entries and whether the caller has caught up. */
export type Page = { entries: StoredEntry[]; done: boolean } | { gone: true };

/**
 * How much of the log is kept (ADR-0006): a count cap and a time window, both applying to
 * every Transport. What falls outside either is gone, and a Cursor that pointed into it
 * answers `gone` rather than resuming somewhere arbitrary. Retention is factory
 * configuration; the interface only requires `gone` to be honest.
 */
export interface Retention {
  /** How long an Entry stays readable, in seconds. Defaults to 300. */
  window?: number;
  /** How many Entries the log keeps at most. Defaults to 10 000. */
  cap?: number;
}

/** Detaches a listener from the live feed. */
export type Unsubscribe = () => void;

/**
 * The write-only half of a Transport: what a process outside Next.js holds to Publish into an
 * App's log, with no live feed and no replay.
 */
export interface Publisher {
  publish(entry: Entry): Promise<Cursor>;
  tail(): Promise<Cursor>;
  close(): Promise<void>;
}

/**
 * The whole ordered log (ADR-0005): the Publisher half, plus paging strictly after a Cursor
 * and the live feed every Instance reads. `onGap` fires exactly once when the position the
 * subscription resumes from is gone.
 */
export interface Transport extends Publisher {
  read(after: Cursor | undefined, limit: number): Promise<Page>;
  subscribe(
    listener: (entry: StoredEntry) => void,
    options: { onGap: () => void },
  ): Promise<Unsubscribe>;
}

/** Every failure a Transport reports, so an App can catch the family in one clause. */
export class TransportError extends Error {}

/** The backend is unreachable, or did not answer within the operation timeout. */
export class TransportUnavailableError extends TransportError {}

/** The Transport has been closed, and answers nothing further. */
export class TransportClosedError extends TransportError {}

/**
 * The typed publish surface of a worker outside Next.js: an `import type` of the App's
 * Registry over a Publisher, with no runtime Channel data.
 */
export function createPublisher(publisher?: Publisher): never {
  void publisher;

  return notImplemented("createPublisher");
}
