import type { ClientChannels } from "../client/index.js";

import type { Registry } from "./registry.js";

/**
 * The Registry, stripped to what a browser may know: each Channel's key, its name pattern and
 * the names of the events it carries.
 *
 * This is the allowlist of ADR-0002, and it is an allowlist rather than an omission list on
 * purpose. Authorize sits in the Registry next to the Channel it guards and is free to import
 * session or database code; nothing that reaches this result can carry it, because nothing is
 * copied that is not named here. The result is plain data, which is what lets a Server
 * Component pass it as a prop.
 */
export function toClientChannels(sse: Registry): ClientChannels {
  const channels: Record<string, { pattern: string; events: string[] }> = {};
  for (const [key, declaration] of Object.entries(sse.channels)) {
    channels[key] = { pattern: declaration.pattern, events: Object.keys(declaration.events) };
  }

  return channels;
}
