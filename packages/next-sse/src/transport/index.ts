import { notImplemented } from "../internal/not-implemented.js";

/** One item in a Transport's log: a Message or a control entry, tagged with its Channel. */
export type Entry = { readonly channel: string };

/** The write-only half of a Transport: what a process outside Next.js holds. */
export interface Publisher {
  publish(entry: Entry): Promise<string>;
  tail(): Promise<string>;
  close(): Promise<void>;
}

/** The whole ordered log: the Publisher half plus replay and the live feed. */
export interface Transport extends Publisher {
  read(after?: string): Promise<{ entries: Entry[]; gone: boolean }>;
  subscribe(listener: (entry: Entry) => void): Promise<() => void>;
}

/** Every failure a Transport reports, so an App can catch the family in one clause. */
export class TransportError extends Error {}

/** The backend cannot be reached, or did not answer within the operation timeout. */
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
