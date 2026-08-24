/**
 * The App's data, such as it is: one list per thing this App shows, in this Instance's memory.
 *
 * A real App reads and writes a database here, and nothing else about the example would change:
 * what the library cares about is that the read happens inside `sse.snapshot(...)`, so that the
 * Cursor is taken before it. This one is per Instance on purpose — the second Instance of a
 * two-Instance run has lists of its own — which is exactly the kind of staleness the handoff is
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
 *
 * One Map holds every list this App keeps, under a name of its own — a room, the admin notices,
 * one reader's notifications, the broadcast. The Channels are named the same way for the same
 * reason, and the resemblance stops there: this is the App's data, and what a Connection may
 * read of it is the Registry's business.
 */
const SLOT = Symbol.for("next-sse-example/lists");
const globals = globalThis as unknown as { [key: symbol]: Map<string, Message[]> | undefined };
const lists = (globals[SLOT] ??= new Map<string, Message[]>());

/** Everything that list holds, oldest first, and an empty one for a list nothing wrote yet. */
function listOf(name: string): Message[] {
  return lists.get(name) ?? [];
}

/** Add one Message to a list and hand it back, id and all, for the Publish that follows. */
function appendTo(name: string, text: string): Message {
  const message: Message = { id: crypto.randomUUID(), text };
  lists.set(name, [...listOf(name), message]);

  return message;
}

/** Everything this room has, oldest first. */
export function listMessages(roomId: string): Message[] {
  return listOf(`room:${roomId}`);
}

/** One Message into the room, ready to be Published. */
export function appendMessage(roomId: string, text: string): Message {
  return appendTo(`room:${roomId}`, text);
}

/** Everything the admin Channel has, oldest first: the read the admin Snapshot is taken of. */
export function listNotices(): Message[] {
  return listOf("notices");
}

/** One notice, ready to be Published on the admin Channel. */
export function appendNotice(text: string): Message {
  return appendTo("notices", text);
}

/** What every reader of this App sees, oldest first, whoever they are. */
export function listAnnouncements(): Message[] {
  return listOf("announcements");
}

/** One announcement, ready to be Published to everybody. */
export function appendAnnouncement(text: string): Message {
  return appendTo("announcements", text);
}

/** What this reader alone has been sent, oldest first: the read their Snapshot is taken of. */
export function listNotifications(userId: string): Message[] {
  return listOf(`notifications:${userId}`);
}

/** One notification for one reader, ready to be Published on the Channel only they may read. */
export function appendNotification(userId: string, text: string): Message {
  return appendTo(`notifications:${userId}`, text);
}
