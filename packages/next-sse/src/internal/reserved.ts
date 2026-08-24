/**
 * The Registry's own keys: a Channel cannot be named after one, because the Registry needs the
 * property for itself (ADR-0008). `handlers` is the route file's export, `channels` is what
 * `<SSEProvider>` shares with the client, `cursor` and `snapshot` are the server-render handoff
 * of ADR-0007, and `kick` and `drain` are the calls the tickets that own them put on the same
 * object.
 *
 * This tuple is the one place the list exists: the compile-time guard reads its members and
 * the runtime throw iterates it, so a name added here is enforced both ways at once.
 */
export const RESERVED_REGISTRY_KEYS = [
  "handlers",
  "channels",
  "cursor",
  "snapshot",
  "kick",
  "drain",
] as const;

/** A Registry key the library holds. */
export type ReservedRegistryKey = (typeof RESERVED_REGISTRY_KEYS)[number];

/**
 * The names a Handle already answers to: every declared event becomes a method of the Handle,
 * so an event called `publish` would take the Handle's own (ADR-0008). Same tuple discipline
 * as the Registry keys.
 */
export const RESERVED_EVENT_NAMES = ["publish", "snapshot", "pattern", "params", "name"] as const;

/** An event name the library holds. */
export type ReservedEventName = (typeof RESERVED_EVENT_NAMES)[number];
