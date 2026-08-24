import { TransportError, type Cursor, type Entry } from "./index.js";

/** The Prefix an App gets when it names none (ADR-0006). */
export const DEFAULT_PREFIX = "next-sse";

/** The one stream field the envelope travels in. */
export const ENTRY_FIELD = "entry";

/** The position before the first Entry, which is what an empty stream answers everywhere. */
export const BEFORE_ANYTHING = "0-0";

/** A brace breaks the hash tag; whitespace and control characters make a key nobody can name. */
const CONTROL_CHARACTER_CEILING = 0x20;
const DELETE_CHARACTER = 0x7f;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;

    return code < CONTROL_CHARACTER_CEILING || code === DELETE_CHARACTER;
  });
}

const REFUSED_IN_PREFIX = /[{}\s]/;

/**
 * The Prefix, checked. It is the only thing keeping two Apps on one server apart, it goes
 * inside the hash tag, and it is otherwise verbatim.
 */
export function assertPrefix(prefix: string): string {
  if (prefix === "") throw new TransportError("The Prefix must not be empty.");
  if (REFUSED_IN_PREFIX.test(prefix) || hasControlCharacter(prefix)) {
    throw new TransportError(
      `The Prefix must contain no braces, whitespace or control characters, was \`${prefix}\`.`,
    );
  }

  return prefix;
}

/**
 * The one key an App owns: `{<Prefix>}:log`. The Prefix sits inside the hash tag, so every key
 * this App will ever own lands in one cluster slot.
 */
export function logKeyOf(prefix: string): string {
  return `{${assertPrefix(prefix)}}:log`;
}

/**
 * Whether a Cursor is one a Redis Stream could have minted. A Cursor that is not — one from
 * another Transport, or no Cursor format at all — is `gone`, never a rejection (ADR-0005).
 */
export function isStreamId(cursor: Cursor): boolean {
  return /^\d+-\d+$/.test(cursor);
}

/** Where one stream ID sits relative to another: negative, zero or positive, as `sort` wants. */
export function compareIds(left: string, right: string): number {
  const [leftMs, leftSeq] = parseId(left);
  const [rightMs, rightSeq] = parseId(right);

  return leftMs === rightMs ? leftSeq - rightSeq : leftMs - rightMs;
}

function parseId(id: string): [number, number] {
  const [ms, seq] = id.split("-");

  return [Number(ms), Number(seq)];
}

/** What `XINFO STREAM` is read for: the tail, and the boundary `gone` is decided on. */
export interface StreamInfo {
  /** The position the log has reached, which survives the log going empty. */
  lastGeneratedId: string;
  /**
   * The oldest position the log still serves: the oldest Entry it holds, or — once retention has
   * emptied it — the position it had reached, since everything up to there is gone. Read
   * together with `everDropped`, this is what makes `gone` honest: a log only ever drops from
   * its front, so everything strictly after a Cursor is still there exactly when the log has
   * dropped nothing, or the Cursor is at or above this.
   *
   * ADR-0006 wrote that rule on `max-deleted-entry-id`, which measurement showed to be updated
   * by `XDEL` alone: trimming — `MAXLEN ~`, exact `MAXLEN` and `XTRIM MINID` alike — leaves it
   * at `0-0` on both Redis 8 and Valkey 8, so a log that only ever trims would never answer
   * `gone` at all. The ADR carries the correction.
   */
  oldestKeptId: string;
  /** Whether this log has ever dropped an Entry, which is the only way a Cursor can be gone. */
  everDropped: boolean;
}

const LAST_GENERATED_ID = "last-generated-id";
const RECORDED_FIRST_ENTRY_ID = "recorded-first-entry-id";
const FIRST_ENTRY = "first-entry";
const ENTRIES_ADDED = "entries-added";
const LENGTH = "length";

/**
 * `XINFO STREAM`, whichever RESP version answered it: a flat field/value array on RESP2, a map
 * on RESP3. A stream that holds nothing reports the position before its first Entry, which
 * nothing is below.
 */
export function readStreamInfo(reply: unknown): StreamInfo {
  const fields = readMap(reply, "XINFO STREAM");
  const lastGeneratedId =
    asString(fields.get(LAST_GENERATED_ID), "XINFO STREAM") ?? BEFORE_ANYTHING;
  const length = numberOf(fields.get(LENGTH));
  const entriesAdded = numberOf(fields.get(ENTRIES_ADDED));

  const firstEntryId =
    asString(fields.get(RECORDED_FIRST_ENTRY_ID), "XINFO STREAM") ??
    firstEntryIdOf(fields.get(FIRST_ENTRY)) ??
    BEFORE_ANYTHING;

  return {
    lastGeneratedId,
    oldestKeptId: length === 0 ? lastGeneratedId : firstEntryId,
    everDropped: entriesAdded > length,
  };
}

/** The id of the `first-entry` a server reports, for one that names no `recorded-first-entry-id`. */
function firstEntryIdOf(entry: unknown): string | undefined {
  return Array.isArray(entry) ? asString(entry[0], "XINFO STREAM") : undefined;
}

function numberOf(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

/** One stream Entry as it comes off the wire: its ID, and the fields it was written with. */
export interface RawEntry {
  id: string;
  fields: string[];
}

/**
 * `XRANGE`, in the one shape both RESP versions answer it: an array of `[id, [field, value]]`
 * pairs.
 */
export function readRange(reply: unknown, command: string): RawEntry[] {
  if (reply === null || reply === undefined) return [];
  if (!Array.isArray(reply)) throw unrecognised(command);

  return reply.map((item: unknown) => {
    if (!Array.isArray(item) || item.length < 2) throw unrecognised(command);
    const id = asString(item[0], command);
    const fields: unknown = item[1];
    if (id === undefined || !Array.isArray(fields)) throw unrecognised(command);

    return {
      id,
      fields: fields.map((field: unknown) => {
        const value = asString(field, command);
        if (value === undefined) throw unrecognised(command);

        return value;
      }),
    };
  });
}

/**
 * `XREAD`, whichever RESP version answered it: an array of `[stream, entries]` pairs on RESP2, a
 * map from stream name to entries on RESP3, and nothing at all when the block timed out. Only
 * one stream is ever asked for, so whatever names it, its Entries are the answer.
 */
export function readStreams(reply: unknown, command: string): RawEntry[] {
  if (reply === null || reply === undefined) return [];

  if (Array.isArray(reply)) {
    return reply.flatMap((item: unknown) => {
      if (Array.isArray(item) && item.length >= 2) return readRange(item[1], command);
      if (isRecord(item) && "messages" in item) return readRange(item.messages, command);

      throw unrecognised(command);
    });
  }

  if (reply instanceof Map) {
    return [...reply.values()].flatMap((entries) => readRange(entries, command));
  }

  if (isRecord(reply)) {
    return Object.values(reply).flatMap((entries) => readRange(entries, command));
  }

  throw unrecognised(command);
}

/**
 * The envelope one stream Entry carries, or `undefined` when this log cannot make an Entry of
 * it: no `entry` field, no JSON, a version this library does not know, a kind it does not know.
 * Nothing beyond that is validated (ADR-0006) — a payload that does not match its schema is an
 * external publisher's business, and is delivered as it stands.
 */
export function parseEntry(fields: readonly string[]): Entry | undefined {
  const at = fields.indexOf(ENTRY_FIELD);
  if (at === -1 || at % 2 !== 0) return undefined;

  const json = fields[at + 1];
  if (json === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed) || parsed.v !== 1) return undefined;

  if (parsed.type === "message") {
    return typeof parsed.channel === "string" && typeof parsed.event === "string"
      ? (parsed as unknown as Entry)
      : undefined;
  }

  if (parsed.type === "control") {
    return parsed.control === "kick" ? (parsed as unknown as Entry) : undefined;
  }

  return undefined;
}

/** A field/value array or a map, whichever the RESP version in play answers with. */
function readMap(reply: unknown, command: string): Map<string, unknown> {
  if (reply instanceof Map) {
    return new Map([...reply].map(([key, value]) => [String(key), value]));
  }

  if (Array.isArray(reply)) {
    const fields = new Map<string, unknown>();
    for (let at = 0; at + 1 < reply.length; at += 2) {
      const key = asString(reply[at], command);
      if (key !== undefined) fields.set(key, reply[at + 1]);
    }

    return fields;
  }

  if (isRecord(reply)) return new Map(Object.entries(reply));

  throw unrecognised(command);
}

/**
 * One reply value as a string. A client configured to answer in Buffers is a caller's posture,
 * not a shape this Transport refuses.
 */
function asString(value: unknown, command: string): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return undefined;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (typeof value === "number" || typeof value === "bigint") return String(value);

  throw unrecognised(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A reply in no shape this Transport knows is a failure, never an empty page: an empty page
 * reads as "caught up", which would turn a shape this library cannot read into silent loss.
 */
function unrecognised(command: string): TransportError {
  return new TransportError(`\`${command}\` answered a reply this Transport cannot read.`);
}
