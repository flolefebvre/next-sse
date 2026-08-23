import type { Cursor, Entry } from "../transport/index.js";

/** A stored Entry that carries a Message, which is the only kind that reaches the wire as one. */
export type StoredMessage = Extract<Entry, { type: "message" }> & { readonly cursor: Cursor };

/**
 * The in-band signals the library sends the client core on a Connection. They belong to no
 * Channel, carry no Cursor and are never replayed.
 */
export type ControlEvent = "ready" | "heartbeat" | "reconnect" | "caught-up" | "reset";

const encoder = new TextEncoder();

/**
 * One Message, framed: the Cursor as the event id, the declared event name, the payload as
 * JSON. The `id:` is what the browser echoes back in `Last-Event-ID`, which is how a
 * reconnect resumes where this Connection stopped.
 */
export function encodeMessage(entry: StoredMessage): Uint8Array {
  return frame([
    ["id", entry.cursor],
    ["event", entry.event],
    ["data", json(entry.payload)],
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
 * A field value with its line breaks taken out. JSON never carries a raw one, but an event
 * name or a Cursor from a publisher outside Next.js is arbitrary text, and a line break in one
 * would end the field early and let the rest of it pose as another field.
 */
function oneLine(value: string): string {
  return value.replace(/[\r\n]/g, "");
}
