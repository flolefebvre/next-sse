import type {
  ChannelDeclaration,
  ChannelRecord,
  EventMap,
  EventsOf,
  JsonOutputs,
  NoReservedEvents,
  NoReservedKeys,
  PatternOf,
} from "../internal/channel.js";
import { assertFillablePattern, fillPattern, type ParamsArgs } from "../internal/pattern.js";
import {
  RESERVED_EVENT_NAMES,
  RESERVED_REGISTRY_KEYS,
  type ReservedRegistryKey,
} from "../internal/reserved.js";
import {
  validatePayload,
  type InferInput,
  type StandardSchemaV1,
} from "../internal/standard-schema.js";
import type { Cursor } from "../transport/index.js";

import { createGetHandler } from "./handler.js";
import type { Instance } from "./instance.js";
import { createHandoff, type Handoff } from "./snapshot.js";

/**
 * A Channel with its params filled in: the value Publish agrees on. Every declared event is a
 * method of its own, and `publish` takes the event name as data, for the call whose event is
 * only known at runtime — dynamic among the events the Channel declares, since an undeclared
 * one has no schema to validate against and no type on the client.
 *
 * A payload is the schema's _Input_: what the App writes, before validation. What reaches the
 * client is the Output the schema produced (ADR-0006).
 */
export type Handle<Events extends EventMap = EventMap> = {
  publish<Name extends keyof Events & string>(
    event: Name,
    payload: InferInput<Events[Name]>,
  ): Promise<Cursor>;
} & {
  [Name in keyof Events & string]: (payload: InferInput<Events[Name]>) => Promise<Cursor>;
};

/**
 * The App's Registry: the route handlers it re-exports, the Channels as declared, the
 * server-render handoff, and one Handle factory per Channel — called with the params its
 * pattern asks for, and with nothing when it asks for none.
 *
 * `channels` is what `<SSEProvider>` strips down and shares with the client, and `cursor` and
 * `snapshot` are the handoff of ADR-0007; all three are Registry keys ADR-0008 reserves,
 * precisely because the Registry needs the properties for itself.
 */
export type Registry<Channels extends ChannelRecord = ChannelRecord> = Handoff & {
  handlers: { GET: (request: Request) => Promise<Response> };
  channels: Channels;
} & {
  [Key in Exclude<keyof Channels & string, ReservedRegistryKey>]: (
    ...args: ParamsArgs<PatternOf<Channels[Key]>>
  ) => Handle<EventsOf<Channels[Key]>>;
};

/**
 * Any App's Registry, as the library's own functions take it: what they read, and no more.
 *
 * A `Registry<Channels>` of a real App is not assignable to `Registry<ChannelRecord>` — its
 * Handle factories are narrower than the index signature that type implies — so everything
 * that only needs to read the declarations asks for exactly that.
 */
export interface RegistryLike {
  handlers: { GET: (request: Request) => Promise<Response> };
  channels: ChannelRecord;
}

/**
 * Declare one Channel: the name pattern its Handles fill in, and the events it carries.
 *
 * Every event is a Standard Schema, so a zod 4, valibot or arktype schema is taken as it is
 * and no schema library is a dependency of this one (ADR-0008); `asType<T>()` covers an event
 * that needs types and no validation. An event whose schema produces something JSON cannot
 * carry is a compile error here, at the declaration, rather than a lie the client discovers
 * (ADR-0006) — and so is an event named after something a Handle already has.
 *
 * Authorize joins this declaration with its own ticket, next to the events it guards.
 */
export function channel<const Pattern extends string, Events extends EventMap>(declaration: {
  pattern: Pattern;
  events: Events & JsonOutputs<Events> & NoReservedEvents<Events>;
}): ChannelDeclaration<Pattern, Events> {
  assertFillablePattern(declaration.pattern);

  const events = declaration.events as Events;
  for (const name of Object.keys(events)) {
    if ((RESERVED_EVENT_NAMES as readonly string[]).includes(name)) {
      throw new Error(
        `next-sse: the Channel "${declaration.pattern}" declares an event called "${name}", ` +
          `and that name is reserved: a Handle already has it. Reserved event names are ` +
          `${RESERVED_EVENT_NAMES.join(", ")}.`,
      );
    }
  }

  return { pattern: declaration.pattern, events };
}

/**
 * Build the App's Registry from its Channel declarations.
 *
 * The declarations go onto the Instance, so that a re-evaluated module — Turbopack does one per
 * request after an edit — swaps the Registry and nothing else: the Transport and the Connection
 * table it holds are the ones the open Connections are already on (ADR-0004).
 */
export function createSSE<Channels extends ChannelRecord>(
  instance: Instance,
  channels: Channels & NoReservedKeys<Channels>,
): Registry<Channels> {
  const declarations = channels as Channels;
  for (const key of Object.keys(declarations)) {
    if ((RESERVED_REGISTRY_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `next-sse: this App declares a Channel called "${key}", and that name is reserved: ` +
          `the Registry needs the property for itself. Reserved Registry keys are ` +
          `${RESERVED_REGISTRY_KEYS.join(", ")}.`,
      );
    }
  }

  instance.registry = declarations;

  const registry: Record<string, unknown> = {};
  for (const [key, declaration] of Object.entries(declarations)) {
    registry[key] = (params: Record<string, string> = {}) =>
      handleFor(instance, declaration, params);
  }

  const handoff = createHandoff(instance);
  registry.handlers = { GET: createGetHandler(instance) };
  registry.channels = declarations;
  registry.cursor = handoff.cursor;
  registry.snapshot = handoff.snapshot;

  return registry as unknown as Registry<Channels>;
}

/**
 * One bound Handle: the Channel name this pattern and these params make, and a Publish for
 * every event the Channel declares.
 */
function handleFor(
  instance: Instance,
  declaration: ChannelDeclaration,
  params: Record<string, string>,
): Handle {
  const name = fillPattern(declaration.pattern, params);
  const publish = async (event: string, payload: unknown): Promise<Cursor> => {
    const schema: StandardSchemaV1 | undefined = declaration.events[event];
    if (schema === undefined) {
      throw new Error(
        `next-sse: the Channel "${declaration.pattern}" carries no event called "${event}". ` +
          `It carries ${Object.keys(declaration.events).join(", ") || "none"}.`,
      );
    }

    return instance.transport.publish({
      v: 1,
      type: "message",
      channel: name,
      event,
      payload: await validatePayload(schema, name, event, payload),
    });
  };

  const handle = { publish } as Handle;
  for (const event of Object.keys(declaration.events)) {
    handle[event] = (payload: unknown) => publish(event, payload);
  }

  return handle;
}
