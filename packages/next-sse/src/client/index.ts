import { notImplemented } from "../internal/not-implemented.js";

/**
 * The opaque value a server component hands the client to make server-rendered data live:
 * the data it read, and the Cursor taken just before that read.
 */
export type Snapshot<Data = unknown> = { readonly data: Data };

/** Where a Connection stands, as the hooks report it. */
export type Status = "connecting" | "open" | "closed";

/**
 * The client-side entry a React tree is built on: one Connection, shared by every hook.
 */
export function createClient(options?: unknown): never {
  void options;

  return notImplemented("createClient");
}

/**
 * The public client provider, for an App that overrides the default Reset behaviour by
 * composition rather than mounting the Server Component provider.
 */
export function SSEClientProvider(props?: unknown): never {
  void props;

  return notImplemented("SSEClientProvider");
}

/**
 * The keyed-merge reducer that covers the Snapshot/replay overlap, Kick replay and the echo
 * of a server action alike.
 */
export function upsertBy(key?: unknown): never {
  void key;

  return notImplemented("upsertBy");
}
