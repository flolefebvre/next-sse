import type { Cursor, Entry } from "../transport/index.js";

/** A stored Entry that carries a Message, which is the only kind that reaches the wire as one. */
export type StoredMessage = Extract<Entry, { type: "message" }> & { readonly cursor: Cursor };

/**
 * The in-band signals the library sends the client core on a Connection. They belong to no
 * Channel, are never a position in the log — no `id:`, so none of them moves the client's Cursor
 * by being received — and are never replayed. `ready` and `reset` do *name* a position, in their
 * data, which is a value the core is told rather than one the wire moves under it.
 */
export type ControlEvent = "ready" | "heartbeat" | "reconnect" | "caught-up" | "reset";

/**
 * What `ready` carries: where this Connection resumes from, and the Channels it asked for that
 * did not pass Authorize (ADR-0003, ADR-0004).
 *
 * `cursor` is optional, and the one case it is absent is the one where every requested Channel
 * was refused: no Connection was opened, so there is no position to name and nothing to resume.
 * Reading the log's tail to fill the field would be a Transport round trip — one that can fail —
 * for a Connection that will never exist, and the client core is written to expect nothing here.
 */
export interface Ready {
  cursor?: Cursor;
  refused: string[];
  /**
   * How often this Connection will be sent a `heartbeat`, in milliseconds, so that the client
   * core can watch the pipe without the interval being configured on both sides (ADR-0004).
   * `0` is a Connection that will not be heartbeated at all, and disarms the watchdog.
   *
   * Absent for the one stream that is no Connection: every Channel refused, nothing to carry,
   * nothing to watch.
   */
  heartbeat?: number;
}

/**
 * What `reset` carries: the position the Connection continues from, once the Cursor it brought
 * turned out to be unusable (ADR-0004).
 *
 * It is the tail the Instance adopted, or the position the live feed resumed from — the same
 * kind of value `ready` carries, and it is here for the same reason: without it a client whose
 * Cursor was refused keeps holding that Cursor, and a page with no Snapshot to supersede it meets
 * the very same refusal on its next reconnect. The value stays opaque and is never compared
 * (ADR-0001), and it travels in the `data` because a Control event carries no `id:`.
 */
export interface Reset {
  cursor: Cursor;
}

const encoder = new TextEncoder();

/**
 * One Message, framed: the Cursor as the event id, and the ADR-0006 envelope — Channel, event
 * name and payload — as the data.
 *
 * The block carries **no `event:` line**. A Message is the unnamed default block of the SSE
 * grammar (the browser dispatches it as `message`); Control events are the named blocks. That
 * is the whole rule, and it is what keeps the two apart: a declared event name never reaches
 * the `event:` field, so an App may declare an event called `heartbeat` or `caught-up` without
 * it posing as a Control event on the wire. It is also why the Channel travels in the data —
 * one Connection carries many Channels, and the client core has nothing else to tell them
 * apart by.
 *
 * The `id:` is what the browser echoes back in `Last-Event-ID`, which is how a reconnect
 * resumes where this Connection stopped.
 */
export function encodeMessage(entry: StoredMessage): Uint8Array {
  return frame([
    ["id", entry.cursor],
    ["data", json({ channel: entry.channel, event: entry.event, payload: entry.payload })],
  ]);
}

/**
 * One Control event, framed. It carries no `id:` on purpose (ADR-0004): a Control event is not
 * a position in the log, and moving the client's `Last-Event-ID` to one would make the next
 * reconnect resume from a place no Message occupies. A data line is always written, because a
 * block with no data dispatches no event at all in the browser.
 */
export function encodeControl(control: ControlEvent, data: unknown = {}): Uint8Array {
  return frame([
    ["event", control],
    ["data", json(data)],
  ]);
}

/** How long the browser waits before reconnecting on its own, in milliseconds. */
export function encodeRetry(milliseconds: number): Uint8Array {
  return frame([["retry", String(Math.trunc(milliseconds))]]);
}

/** One SSE block: its fields, then the blank line that dispatches it. */
function frame(fields: [string, string][]): Uint8Array {
  const lines = fields.map(([name, value]) => `${name}: ${oneLine(value)}\n`);

  return encoder.encode(`${lines.join("")}\n`);
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

/**
 * A field value with its line breaks taken out. JSON never carries a raw one, but a Cursor is
 * arbitrary text minted by the Transport, and a line break in one would end the field early and
 * let the rest of it pose as another field.
 */
function oneLine(value: string): string {
  return value.replace(/[\r\n]/g, "");
}
