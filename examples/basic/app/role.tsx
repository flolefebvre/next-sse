import type { Role } from "@/lib/session";

import { switchRole } from "./actions";

/**
 * Who the page is rendered for, switchable in one click, because a demo of refusal needs both
 * sides of it. A real App signs a user in instead; nothing below the fold changes.
 */
export function RoleSwitch({ role }: { role: Role }) {
  return (
    <form>
      <p data-testid="role">{role}</p>
      <button formAction={switchRole.bind(null, role === "admin" ? "guest" : "admin")}>
        {role === "admin" ? "Become a guest" : "Become an admin"}
      </button>
    </form>
  );
}
