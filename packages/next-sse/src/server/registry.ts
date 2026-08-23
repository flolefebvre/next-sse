import { fillPattern } from "../internal/pattern.js";
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

/**
 * The App's Registry: the route handlers it re-exports, the Channels as declared, and one
 * Handle factory per Channel.
 *
 * `channels` is what `<SSEProvider>` strips down and shares with the client; it is one of the
 * Registry keys ADR-0008 reserves, precisely because the Registry needs it for itself.
 */
export type Registry = {
  handlers: { GET: (request: Request) => Promise<Response> };
  channels: Record<string, ChannelDeclaration>;
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

  const registry: Record<string, unknown> = {};
  for (const [key, declaration] of Object.entries(channels)) {
    registry[key] = (params: Record<string, string> = {}) =>
      handleFor(instance, declaration, params);
  }

  /**
   * The Registry's own keys are written last, so a Channel that happens to be named after one
   * cannot take it. ADR-0008 reserves both names and requires a runtime throw for an App that
   * uses one; that throw pairs with the type-level enforcement and belongs to the typing
   * ticket. Until it lands, the cost of declaring a Channel called `channels` is that its
   * Handle factory is missing — loud, at the Publish that needs it — rather than an allowlist
   * that quietly comes out empty and takes every subscription in the App with it.
   */
  registry.handlers = { GET: createGetHandler(instance) };
  registry.channels = channels;

  return registry as unknown as Registry;
}

function handleFor(
  instance: Instance,
  declaration: ChannelDeclaration,
  params: Record<string, string>,
): Handle {
  const name = fillPattern(declaration.pattern, params);
  const publish = (event: string, payload: unknown): Promise<Cursor> =>
    instance.transport.publish({ v: 1, type: "message", channel: name, event, payload });

  const handle = { publish } as Handle;
  for (const event of Object.keys(declaration.events)) {
    handle[event] = (payload: unknown) => publish(event, payload);
  }

  return handle;
}
