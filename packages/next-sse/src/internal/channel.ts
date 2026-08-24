import type { IsJson } from "./json.js";
import type { ReservedEventName, ReservedRegistryKey } from "./reserved.js";
import type { InferOutput, StandardSchemaV1 } from "./standard-schema.js";

/** The events a Channel carries, by name: one Standard Schema each. */
export type EventMap = Record<string, StandardSchemaV1>;

/** One Channel, as the App declares it: its name pattern and the events it carries. */
export interface ChannelDeclaration<
  Pattern extends string = string,
  Events extends EventMap = EventMap,
> {
  /** The Channel name, with `{name}` where a param goes: `chat:{roomId}`. */
  readonly pattern: Pattern;
  /** The events this Channel carries, by name. One method per key lands on the Handle. */
  readonly events: Events;
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
