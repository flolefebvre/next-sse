/**
 * Who is asking, as this example decides it: a cookie, and nothing more.
 *
 * A real App reads a session here — the whole point of ADR-0002's colocated Registry is that
 * this file may import anything the server can reach, because none of it crosses to the client.
 * The one thing worth copying is where it is read from: `context` is handed the `Request`, so
 * the session is parsed from that request rather than from `next/headers`, which the SSE route
 * handler is not free to use.
 */
export type Role = "admin" | "guest";

/** What this App builds per Connection: what its Authorize decides on, and what names it. */
export interface Session {
  /** The Key of the Connection: what a Kick would address it by. */
  userId: string;
  role: Role;
}

export const ROLE_COOKIE = "role";
export const USER_COOKIE = "user";

/** The session a `Cookie` header carries, with the guest one as the default. */
export function sessionFrom(cookie: string | null): Session {
  return {
    userId: valueOf(cookie, USER_COOKIE) ?? "anonymous",
    role: valueOf(cookie, ROLE_COOKIE) === "admin" ? "admin" : "guest",
  };
}

function valueOf(cookie: string | null, name: string): string | undefined {
  for (const pair of (cookie ?? "").split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }

  return undefined;
}
