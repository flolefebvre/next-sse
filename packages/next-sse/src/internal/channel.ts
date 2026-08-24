import type { IsJson } from "./json.js";
import type { ParamsOf } from "./pattern.js";
import type { ReservedEventName, ReservedRegistryKey } from "./reserved.js";
import type { InferOutput, StandardSchemaV1 } from "./standard-schema.js";

/**
 * The App's decision whether a Connection may subscribe to a Channel, as the App writes it: the
 * params its pattern names, and the context this App builds per request (ADR-0003). It is taken
 * once per Channel when the Connection opens, and again on every reconnect — never per Message
 * — so it is free to do the async work a session or database read takes.
 */
export type Authorize<Pattern extends string, Ctx> = (
  params: ParamsOf<Pattern>,
  ctx: Ctx,
) => boolean | Promise<boolean>;

/**
 * Authorize as the Registry carries it, once the declaration is read as data: neither the
 * params of the pattern nor the App's Ctx are knowable from a `ChannelDeclaration` alone, and
 * `never` is what says so — every Authorize an App writes is assignable to this, and calling
 * one takes the cast the handler makes once, in the one place where both are known.
 */
export type DeclaredAuthorize = (params: never, ctx: never) => boolean | Promise<boolean>;

/** The events a Channel carries, by name: one Standard Schema each. */
export type EventMap = Record<string, StandardSchemaV1>;

/** One Channel, as the App declares it: its name pattern, its events, and what guards it. */
export interface ChannelDeclaration<
  Pattern extends string = string,
  Events extends EventMap = EventMap,
> {
  /** The Channel name, with `{name}` where a param goes: `chat:{roomId}`. */
  readonly pattern: Pattern;
  /** The events this Channel carries, by name. One method per key lands on the Handle. */
  readonly events: Events;
  /** Whether a Connection may subscribe to this Channel. Never reaches the client (ADR-0002). */
  readonly authorize: DeclaredAuthorize;
}

/** The App's Channels, by Registry key. */
export type ChannelRecord = Record<string, ChannelDeclaration>;

/** The pattern a declared Channel was written with. */
export type PatternOf<Declaration extends ChannelDeclaration> = Declaration["pattern"];

/** The events a declared Channel carries, with their schemas: what types a payload on both sides. */
export type EventsOf<Declaration extends ChannelDeclaration> = Declaration["events"];

/**
 * The `events` map, with every schema whose Output JSON cannot carry replaced by the reason.
 *
 * The compiler has no way to attach a message to a failed constraint, so the message _is_ the
 * type it asks for: intersecting this with the real map leaves the offending property with an
 * impossible type, and TypeScript prints the sentence at the property that caused it. That is
 * the honest limit of what the language allows, and it beats `Type 'ZodDate' does not satisfy
 * the constraint 'never'`.
 */
export type JsonOutputs<Events extends EventMap> = {
  [Name in keyof Events]: IsJson<InferOutput<Events[Name]>> extends true
    ? unknown
    : `next-sse: the "${Name & string}" event must produce something JSON can carry — z.date() does not, z.iso.datetime() does`;
};

/** The `events` map, with every name a Handle already answers to replaced by the reason. */
export type NoReservedEvents<Events extends EventMap> = {
  [Name in keyof Events]: Name extends ReservedEventName
    ? `next-sse: "${Name & string}" is a reserved event name — a Handle already has it`
    : unknown;
};

/** The Channel record, with every key the Registry needs for itself replaced by the reason. */
export type NoReservedKeys<Channels extends ChannelRecord> = {
  [Key in keyof Channels]: Key extends ReservedRegistryKey
    ? `next-sse: "${Key & string}" is a reserved Registry key — name the Channel something else`
    : unknown;
};
