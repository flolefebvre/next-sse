import type {
  Authorize,
  ChannelDeclaration,
  ChannelRecord,
  DeclaredAuthorize,
  EventMap,
  EventsOf,
  JsonOutputs,
  NoReservedEvents,
  NoReservedKeys,
  PatternOf,
} from "../internal/channel.js";
import {
  assertFillablePattern,
  collidingName,
  fillPattern,
  matchPattern,
  type ParamsArgs,
} from "../internal/pattern.js";
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
import { createKick, type Kick } from "./kick.js";
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
  /**
   * The Channel this Handle is bound to, as a string: the pattern with its params filled in
   * (`chat:42`), never the Registry key it was declared under (`chat`). It is the exact value a
   * Connection's Channel set holds, which is what makes `sse.kick(handle)` a match on it.
   */
  readonly name: string;
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
 * `channels` is what `<SSEProvider>` strips down and shares with the client, `cursor` and
 * `snapshot` are the handoff of ADR-0007, `kick` is the revocation of ADR-0003 and `drain` is
 * the shutdown of ADR-0011; all of them are Registry keys ADR-0008 reserves, precisely because
 * the Registry needs the properties for itself.
 */
export type Registry<Channels extends ChannelRecord = ChannelRecord> = Handoff & {
  handlers: { GET: (request: Request) => Promise<Response> };
  channels: Channels;
  kick: Kick;
  /**
   * Shut this Instance down and resolve when it is done: new connects answered `503`, every
   * Connection ended with `reconnect` over the drain window, then the Transport closed. It is
   * what the signal handlers call, and what a custom server or a test sequences its own
   * shutdown on. Idempotent: every call joins the Drain in flight (ADR-0011).
   */
  drain: () => Promise<void>;
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
 * Declare one Channel, as the App's own `initSSE` hands it back: the name pattern its Handles
 * fill in, the events it carries, and the Authorize that guards it.
 *
 * The factory is bound to the App's Ctx, which is the reason `initSSE` returns it rather than
 * the package exporting one: whatever the App's `context` builds is what its Authorize is
 * handed, and an App that configures no `context` gets `undefined` (ADR-0008).
 */
export interface ChannelFactory<Ctx> {
  <const Pattern extends string, Events extends EventMap>(declaration: {
    pattern: Pattern;
    events: Events & JsonOutputs<Events> & NoReservedEvents<Events>;
    authorize: Authorize<Pattern, Ctx>;
  }): ChannelDeclaration<Pattern, Events>;
}

/**
 * Declare one Channel: the name pattern its Handles fill in, the events it carries, and the
 * decision that guards it.
 *
 * Every event is a Standard Schema, so a zod 4, valibot or arktype schema is taken as it is
 * and no schema library is a dependency of this one (ADR-0008); `asType<T>()` covers an event
 * that needs types and no validation. An event whose schema produces something JSON cannot
 * carry is a compile error here, at the declaration, rather than a lie the client discovers
 * (ADR-0006) — and so is an event named after something a Handle already has.
 *
 * `authorize` is required, and it sits here rather than in a table of its own so that a Channel
 * and the rule that guards it are read together and cannot drift apart (ADR-0002). A public
 * Channel writes `() => true`, which is a decision an App takes on purpose rather than one it
 * forgets to take. This module is server-only, so Authorize may import session or database code
 * freely: what crosses to the client is the allowlist of `toClientChannels`, and Authorize is
 * not on it.
 *
 * The Ctx is `never` here and the App's own where it matters: `initSSE` hands back this same
 * function typed as its `ChannelFactory<Ctx>`, which is where an App's Authorize gets its
 * context type.
 */
export const channel: ChannelFactory<never> = declareChannel;

function declareChannel<const Pattern extends string, Events extends EventMap>(declaration: {
  pattern: Pattern;
  events: Events & JsonOutputs<Events> & NoReservedEvents<Events>;
  authorize: DeclaredAuthorize;
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

  return { pattern: declaration.pattern, events, authorize: declaration.authorize };
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

  assertNoOverlap(declarations);
  instance.registry = declarations;

  const registry: Record<string, unknown> = {};
  for (const [key, declaration] of Object.entries(declarations)) {
    registry[key] = (params: Record<string, string> = {}) =>
      handleFor(instance, declaration, params);
  }

  const handoff = createHandoff(instance);
  registry.handlers = { GET: createGetHandler(instance) };
  registry.channels = declarations;
  registry.kick = createKick(instance);
  registry.drain = () => instance.drain();
  registry.cursor = handoff.cursor;
  registry.snapshot = handoff.snapshot;

  return registry as unknown as Registry<Channels>;
}

/**
 * Refuse a Registry where two Channel patterns can make the same Channel name.
 *
 * A Channel name is what everything downstream carries — the Transport an Entry, a Connection its
 * set, a Handle its binding (ADR-0005) — never the Registry key it was declared under. So a name
 * two declarations can both make is one stream of Messages with two typings of it: an Entry
 * published through one Handle is delivered once and read by the subscribers of both, each
 * validating nothing and typing the payload by its own schema. The type would lie to whichever
 * of the two the App did not have in mind, and nothing at all would report it (#68).
 *
 * Ordering does settle Authorize — the patterns are tried in declaration order and the first
 * match wins, so a Connection asking for the name is guarded by one rule rather than two — and
 * that is all it settles. It has nothing to say about which schema typed the payload, because
 * the Publish that produced it never went near a Connection. So the overlap is refused here,
 * where the App wrote it, rather than left to a rule that answers a different question.
 *
 * Every pair is compared, params or not: whether two patterns can meet is decidable on the
 * patterns alone (`collidingName`), and where the witness it hands back is a name both patterns
 * genuinely take apart again, the error quotes it.
 */
function assertNoOverlap(declarations: ChannelRecord): void {
  const entries = Object.entries(declarations);
  for (const [index, [key, declaration]] of entries.entries()) {
    for (const [other, candidate] of entries.slice(index + 1)) {
      const name = collidingName(declaration.pattern, candidate.pattern);
      if (name === undefined) continue;

      const shared =
        matchPattern(declaration.pattern, name) !== undefined &&
        matchPattern(candidate.pattern, name) !== undefined
          ? `both name the Channel "${name}"`
          : `can name one and the same Channel`;
      throw new Error(
        `next-sse: the Channel "${key}" declares the pattern "${declaration.pattern}" and the ` +
          `Channel "${other}" declares the pattern "${candidate.pattern}", and they ${shared}: ` +
          `one Message published there is read by the subscribers of both Channels, each typing ` +
          `its payload by its own schema, and a Connection asking for it is authorized by ` +
          `whichever of the two was declared first. Name one of them something the other ` +
          `cannot make.`,
      );
    }
  }
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

  const handle = { name, publish } as Handle;
  for (const event of Object.keys(declaration.events)) {
    handle[event] = (payload: unknown) => publish(event, payload);
  }

  return handle;
}
