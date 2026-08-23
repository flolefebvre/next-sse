import type { Cursor } from "../transport/index.js";

import { createGetHandler } from "./handler.js";
import type { Instance } from "./instance.js";

/** One Channel, as the App declares it: its name pattern and the events it carries. */
export interface ChannelDeclaration {
  /** The Channel name, with `{name}` where a param goes: `chat:{roomId}`. */
  pattern: string;
  /** The events this Channel carries, by name. One method per key lands on the Handle. */
  events: Record<string, unknown>;
}

/**
 * A Channel with its params filled in: the value Publish agrees on. `publish` takes a dynamic
 * event name; every declared event is also a method of its own.
 */
export type Handle = {
  publish(event: string, payload: unknown): Promise<Cursor>;
} & Record<string, (payload: unknown) => Promise<Cursor>>;

/** The App's Registry: the route handlers it re-exports, and one Handle factory per Channel. */
export type Registry = {
  handlers: { GET: (request: Request) => Promise<Response> };
} & Record<string, (params?: Record<string, string>) => Handle>;

/** Declare one Channel. Authorize and event schemas join this signature with their own tickets. */
export function channel(declaration: ChannelDeclaration): ChannelDeclaration {
  return declaration;
}

/**
 * Build the App's Registry from its Channel declarations.
 *
 * The declarations go onto the Instance, so that a re-evaluated module — Turbopack does one per
 * request after an edit — swaps the Registry and nothing else: the Transport and the Connection
 * table it holds are the ones the open Connections are already on (ADR-0004).
 */
export function createSSE(
  instance: Instance,
  channels: Record<string, ChannelDeclaration>,
): Registry {
  instance.registry = channels;

  const registry = { handlers: { GET: createGetHandler(instance) } } as Registry;
  for (const [key, declaration] of Object.entries(channels)) {
    registry[key] = (params = {}) => handleFor(instance, declaration, params);
  }

  return registry;
}

function handleFor(
  instance: Instance,
  declaration: ChannelDeclaration,
  params: Record<string, string>,
): Handle {
  const name = channelName(declaration.pattern, params);
  const publish = (event: string, payload: unknown): Promise<Cursor> =>
    instance.transport.publish({ v: 1, type: "message", channel: name, event, payload });

  const handle = { publish } as Handle;
  for (const event of Object.keys(declaration.events)) {
    handle[event] = (payload: unknown) => publish(event, payload);
  }

  return handle;
}

/**
 * The Channel name a Handle publishes to: the pattern with every `{name}` replaced by the param
 * of that name. A param the caller did not give is an error rather than a Channel name with a
 * brace in it, which would reach the wire and silently match nothing.
 */
function channelName(pattern: string, params: Record<string, string>): string {
  return pattern.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`The Channel "${pattern}" needs a "${name}" param, and none was given.`);
    }

    return value;
  });
}
