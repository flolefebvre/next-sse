"use client";

import type { Role } from "@/lib/session";

import { kickMe, switchRole } from "./actions";

/**
 * Who the page is rendered for, switchable in one click, because a demo of refusal needs both
 * sides of it. A real App signs a user in instead; nothing below the fold changes.
 *
 * The two calls are ordered on purpose: the session is changed first, and only then is this
 * reader Kicked, from a request that already carries the new cookies. That is what makes the
 * reconnect Authorize against the new session every time rather than most of the time — see
 * `kickMe`. It is why this is a Client Component: a server `formAction` can only be one call.
 */
export function RoleSwitch({ role }: { role: Role }) {
  const next: Role = role === "admin" ? "guest" : "admin";

  return (
    <form
      action={async () => {
        await switchRole(next);
        await kickMe();
      }}
    >
      <p data-testid="role">{role}</p>
      <button type="submit">{role === "admin" ? "Become a guest" : "Become an admin"}</button>
    </form>
  );
}
