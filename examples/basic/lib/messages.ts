/**
 * The App's data, such as it is: the Messages of each room, in this Instance's memory.
 *
 * A real App reads and writes a database here, and nothing else about the example would change:
 * what the library cares about is that the read happens inside `sse.snapshot(...)`, so that the
 * Cursor is taken before it. This one is per Instance on purpose — the second Instance of a
 * two-Instance run has a list of its own — which is exactly the kind of staleness the handoff is
 * built to survive: a Publish reaches every Instance's Connections whatever their server render
 * had, and `upsertBy` merges the two views.
 */
export interface Message {
  id: string;
  text: string;
}

/**
 * The store lives on a `globalThis` slot for the same reason the library's Instance does
 * (ADR-0004): a Route Handler and a Server Component do not necessarily share a module
 * registry — nor does a module re-evaluated by a hot reload — so a plain module-level `Map`
 * would give the webhook one list and the page another, and the page would render an empty room
 * a moment after a Publish went through.
 */
const SLOT = Symbol.for("next-sse-example/messages");
const globals = globalThis as unknown as { [key: symbol]: Map<string, Message[]> | undefined };
const rooms = (globals[SLOT] ??= new Map<string, Message[]>());

/** Everything this room has, oldest first. */
export function listMessages(roomId: string): Message[] {
  return rooms.get(roomId) ?? [];
}

/** Add one Message to the room and hand it back, id and all, for the Publish that follows. */
export function appendMessage(roomId: string, text: string): Message {
  const message: Message = { id: crypto.randomUUID(), text };
  rooms.set(roomId, [...listMessages(roomId), message]);

  return message;
}
