import type { ChannelRecord, EventsOf, PatternOf } from "../internal/channel.js";
import type { InferOutput } from "../internal/standard-schema.js";

/**
 * The opaque, Transport-minted position in an App's Message flow. Its format belongs to the
 * Transport that minted it (ADR-0001) and everything above compares it by equality only.
 */
export type Cursor = string;

/** One item in a Transport's log: the wire envelope of ADR-0006, round-tripped as JSON. */
export type Entry =
  | { readonly v: 1; readonly type: "message"; channel: string; event: string; payload: unknown }
  | { readonly v: 1; readonly type: "control"; control: "kick"; key?: string; channel?: string };

/**
 * An Entry as it comes back out of the log: the envelope that was published, plus the Cursor
 * the Transport minted for it. The Cursor is not part of the stored JSON (ADR-0006's envelope
 * is what an external publisher writes, and it has none); the Transport attaches it on the way
 * out, from the position it already holds.
 */
export type StoredEntry = Entry & { readonly cursor: Cursor };

/** What one page of a `read` answers: Entries and whether the caller has caught up. */
export type Page = { entries: StoredEntry[]; done: boolean } | { gone: true };

/**
 * How much of the log is kept (ADR-0006): a count cap and a time window, both applying to
 * every Transport. What falls outside either is gone, and a Cursor that pointed into it
 * answers `gone` rather than resuming somewhere arbitrary. Retention is factory
 * configuration; the interface only requires `gone` to be honest.
 */
export interface Retention {
  /** How long an Entry stays readable, in seconds. Defaults to 300. */
  window?: number;
  /** How many Entries the log keeps at most. Defaults to 10 000. */
  cap?: number;
}

/** Detaches a listener from the live feed. */
export type Unsubscribe = () => void;

/**
 * The write-only half of a Transport: what a process outside Next.js holds to Publish into an
 * App's log, with no live feed and no replay.
 */
export interface Publisher {
  publish(entry: Entry): Promise<Cursor>;
  tail(): Promise<Cursor>;
  close(): Promise<void>;
}

/**
 * The whole ordered log (ADR-0005): the Publisher half, plus paging strictly after a Cursor
 * and the live feed every Instance reads. `onGap` fires exactly once when the position the
 * subscription resumes from is gone, and is handed a position in its place: the oldest one this
 * log can still serve, which everything the feed is about to deliver comes at or after.
 *
 * That argument is what lets the Instance tell its Connections where they now stand rather than
 * only that they are lost: a position this layer already holds travels in band, and is never
 * read back out of the log by whoever needs it (ADR-0004). It is passed on to clients, so it
 * must be a position `read` will serve rather than one it answers `gone` for — which rules out
 * the position just below the oldest Entry, however naturally a reader resumes there.
 */
export interface Transport extends Publisher {
  read(after: Cursor | undefined, limit: number): Promise<Page>;
  subscribe(
    listener: (entry: StoredEntry) => void,
    options: { onGap: (resumeFrom: Cursor) => void },
  ): Promise<Unsubscribe>;
}

/**
 * Every failure a Transport reports, so an App can catch the family in one clause.
 *
 * Each of them names itself, as `DeadlineError` and `InvalidPayloadError` do: a subclass of
 * `Error` that sets no `name` is printed as `Error` by every logger and test runner there is,
 * and a backend failure that says only `Error: Socket closed unexpectedly` costs whoever reads
 * it the one thing the taxonomy is for — knowing which kind of failure it was (#86).
 */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/** The backend is unreachable, or did not answer within the operation timeout. */
export class TransportUnavailableError extends TransportError {
  constructor(message: string) {
    super(message);
    this.name = "TransportUnavailableError";
  }
}

/** The Transport has been closed, and answers nothing further. */
export class TransportClosedError extends TransportError {
  constructor(message: string) {
    super(message);
    this.name = "TransportClosedError";
  }
}

/**
 * An App's Registry as a worker is allowed to know it: its Channel declarations, and nothing
 * else. `typeof sse` satisfies it, which is the only way a process outside Next.js ever names
 * an App — the Registry module itself pulls the App's Authorize, and so its session and
 * database code, into a process that has no business loading any of it (ADR-0008).
 */
export interface PublishableApp {
  channels: ChannelRecord;
}

/**
 * The Channel names a pattern can make, as a type: every `{param}` becomes `${string}`, so
 * `chat:{roomId}` is `` `chat:${string}` `` and a pattern with no param is the one name it
 * already is.
 *
 * This is the whole of what a worker gets in place of a Handle. It is looser than the filler
 * (ADR-0008): `${string}` also accepts a value carrying a `:`, which `fillPattern` refuses.
 * Narrowing it is not possible in the type system, and it is the price of a publish surface
 * that carries no runtime Channel data at all.
 */
export type ChannelNameOf<Pattern extends string> =
  Pattern extends `${infer Head}{${string}}${infer Rest}`
    ? `${Head}${string}${ChannelNameOf<Rest>}`
    : Pattern;

/** Every Channel name this App's patterns can make. */
export type ChannelNames<App extends PublishableApp> = {
  [Key in keyof App["channels"]]: ChannelNameOf<PatternOf<App["channels"][Key]>>;
}[keyof App["channels"]];

/**
 * The events carried by every declared Channel whose pattern could have made this name.
 *
 * Patterns are matched, not resolved: `chat:42` picks the declaration that could have produced
 * it. Where two of them answer the answer is the union of their event maps, and `keyof` on a
 * union is the events they agree on — the honest answer when the name alone cannot say which
 * declaration a worker meant.
 */
export type EventsFor<App extends PublishableApp, Channel extends string> = {
  [Key in keyof App["channels"]]: Channel extends ChannelNameOf<PatternOf<App["channels"][Key]>>
    ? EventsOf<App["channels"][Key]>
    : never;
}[keyof App["channels"]];

/**
 * Every member of a union at once.
 *
 * The members it is given are boxes, one per matching declaration, and that is the whole point:
 * intersecting the boxes intersects the declarations, while a union _inside_ one declaration's
 * payload — a schema whose Output is a discriminated union — travels in a single box and comes
 * out untouched. Intersecting the payload types directly would collapse that union into an
 * impossible type, and refuse a payload the App declared.
 */
type Intersect<Union> = (Union extends unknown ? (member: Union) => void : never) extends (
  member: infer Single,
) => void
  ? Single
  : never;

/**
 * What one Publish takes: a payload every declaration this Channel name matches would accept.
 *
 * A name that only one pattern can make gives that declaration's Output and nothing else, and
 * that is every name of every App the Registry accepts: `createSSE` refuses two patterns that
 * can make one name, parameterized or not (#68, amending ADR-0002). Where two declarations
 * answer here all the same, the payload owes both, and asking for less would be a type that
 * lies to whichever subscriber the worker did not have in mind.
 *
 * They can still answer, which is why this stays. A worker holds the App as a type and never
 * runs its `createSSE`, so nothing on this path has checked the Registry it was handed; and the
 * type-level match is coarser than the runtime one — `ChannelNameOf` reads a param as `${string}`,
 * which spans the `:` a param may not hold — so a name can reach two declarations here that the
 * matcher would give to one. The obligation is met at the one place the concrete name is known.
 */
type PayloadFor<App extends PublishableApp, Channel extends string, Event extends string> =
  Intersect<
    {
      [Key in keyof App["channels"]]: Channel extends ChannelNameOf<PatternOf<App["channels"][Key]>>
        ? Event extends keyof EventsOf<App["channels"][Key]>
          ? { payload: InferOutput<EventsOf<App["channels"][Key]>[Event]> }
          : never
        : never;
    }[keyof App["channels"]]
  > extends { payload: infer Payload }
    ? Payload
    : never;

/**
 * The typed publish surface of a process outside Next.js: one call, Messages only.
 *
 * A payload here is the schema's **Output**, where a server Handle takes its Input. Nothing on
 * this path validates — the Registry, and so the schemas, never reach this process — and the
 * wire carries Output (ADR-0006). So what a worker writes is what the client will receive,
 * and the type says exactly that.
 */
export interface TypedPublisher<App extends PublishableApp> {
  publish<Channel extends ChannelNames<App>, Event extends keyof EventsFor<App, Channel> & string>(
    channel: Channel,
    event: Event,
    payload: PayloadFor<App, Channel, Event>,
  ): Promise<Cursor>;
}

/**
 * The typed publish surface of a worker outside Next.js: an `import type` of the App's Registry
 * over a Publisher, with no runtime Channel data.
 *
 * ```ts
 * import { createPublisher } from "@flefebvre/next-sse/transport";
 * import { createRedisPublisher } from "@flefebvre/next-sse/transport/redis";
 * import type { sse as app } from "../app/lib/sse";
 *
 * const publisher = createRedisPublisher({ url: process.env.REDIS_URL });
 * const sse = createPublisher<typeof app>(publisher);
 * await sse.publish("chat:42", "message", { id: "1", text: "from the worker" });
 * ```
 *
 * The App's Registry is imported under a name of its own because the worker's own publisher is
 * the thing it will call `sse`: the type comes in as `app`, and the value that shadows nothing
 * keeps the call site reading the way it does inside the App.
 *
 * The type argument is erased with the import it came from: this function reads nothing off the
 * App at runtime, holds no patterns and no schemas, and does no validation. What it adds over
 * `publisher.publish` is the envelope and the types — which is why it covers Messages and
 * nothing else. A worker that must Kick writes the control entry of ADR-0006 on the Publisher
 * itself, and a worker that needs `tail` or `close` already holds the Publisher it made: there
 * is no second door to either (ADR-0008).
 */
export function createPublisher<App extends PublishableApp>(
  publisher: Publisher,
): TypedPublisher<App> {
  return {
    publish: (channel: string, event: string, payload: unknown) =>
      publisher.publish({ v: 1, type: "message", channel, event, payload }),
  };
}
