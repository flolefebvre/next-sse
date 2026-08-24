import { expect, test } from "vitest";

import { TransportError, type Entry } from "./index.js";
import {
  assertPrefix,
  compareIds,
  isStreamId,
  logKeyOf,
  parseEntry,
  readRange,
  readStreamInfo,
  readStreams,
} from "./redis-reply.js";

const message: Entry = {
  v: 1,
  type: "message",
  channel: "chat:42",
  event: "message",
  payload: { text: "one" },
};

/** The fields one stream Entry carries: the single `entry` field of ADR-0006. */
const fieldsOf = (json: string): string[] => ["entry", json];

test("the Prefix goes inside the hash tag, so an App's keys share one slot", () => {
  expect(logKeyOf("next-sse")).toBe("{next-sse}:log");
  expect(logKeyOf("my-app")).toBe("{my-app}:log");
});

test("a Prefix that would break the key, or the tag, is refused", () => {
  expect(() => assertPrefix("")).toThrow(TransportError);
  expect(() => assertPrefix("{app}")).toThrow(/braces, whitespace or control characters/);
  expect(() => assertPrefix("my app")).toThrow(/braces, whitespace or control characters/);
  expect(() => assertPrefix("my\napp")).toThrow(/braces, whitespace or control characters/);
  expect(() => assertPrefix("my\u0007app")).toThrow(/braces, whitespace or control characters/);
  expect(assertPrefix("acme:app-1")).toBe("acme:app-1");
});

test("only what a Stream could have minted is a Cursor this log can read", () => {
  expect(isStreamId("1700000000000-0")).toBe(true);
  expect(isStreamId("0-0")).toBe(true);
  expect(isStreamId("")).toBe(false);
  expect(isStreamId("not-a-cursor")).toBe(false);
  expect(isStreamId("1700000000000")).toBe(false);
  expect(isStreamId("abcd-1")).toBe(false);
});

test("stream IDs order by their two parts, not as strings", () => {
  expect(compareIds("9-0", "10-0")).toBeLessThan(0);
  expect(compareIds("10-0", "9-0")).toBeGreaterThan(0);
  expect(compareIds("10-2", "10-10")).toBeLessThan(0);
  expect(compareIds("10-2", "10-2")).toBe(0);
});

test("XINFO STREAM reads the same on a RESP2 array and a RESP3 map", () => {
  const expected = { lastGeneratedId: "5-0", maxDeletedEntryId: "3-0" };

  expect(
    readStreamInfo(["length", 2, "last-generated-id", "5-0", "max-deleted-entry-id", "3-0"]),
  ).toEqual(expected);
  expect(
    readStreamInfo(
      new Map<string, unknown>([
        ["length", 2],
        ["last-generated-id", "5-0"],
        ["max-deleted-entry-id", "3-0"],
      ]),
    ),
  ).toEqual(expected);
  expect(
    readStreamInfo({ length: 2, "last-generated-id": "5-0", "max-deleted-entry-id": "3-0" }),
  ).toEqual(expected);
});

/** A stream that never lost an Entry says so by having nothing below its first position. */
test("a stream that reports no deletion is read as having dropped nothing", () => {
  expect(readStreamInfo(["length", 0]).maxDeletedEntryId).toBe("0-0");
  expect(readStreamInfo(["length", 0]).lastGeneratedId).toBe("0-0");
});

test("XRANGE is read into Entries with the position they were minted at", () => {
  const reply = [
    ["1-0", fieldsOf(JSON.stringify(message))],
    ["2-0", fieldsOf(JSON.stringify(message))],
  ];

  expect(readRange(reply, "XRANGE").map((entry) => entry.id)).toEqual(["1-0", "2-0"]);
});

test("XREAD reads the same on a RESP2 array of streams and a RESP3 map of them", () => {
  const entries = [["1-0", fieldsOf(JSON.stringify(message))]];

  expect(readStreams([["{app}:log", entries]], "XREAD").map((entry) => entry.id)).toEqual(["1-0"]);
  expect(readStreams(new Map([["{app}:log", entries]]), "XREAD").map((raw) => raw.id)).toEqual([
    "1-0",
  ]);
  expect(readStreams({ "{app}:log": entries }, "XREAD").map((raw) => raw.id)).toEqual(["1-0"]);
  expect(
    readStreams([{ name: "{app}:log", messages: entries }], "XREAD").map((raw) => raw.id),
  ).toEqual(["1-0"]);
});

/** A block that timed out with nothing to say is no Entries, not a failure. */
test("a block that brought nothing back reads as no Entries", () => {
  expect(readStreams(null, "XREAD")).toEqual([]);
  expect(readStreams(undefined, "XREAD")).toEqual([]);
  expect(readRange(null, "XRANGE")).toEqual([]);
});

/**
 * An empty page reads as "caught up", so a shape this library cannot read must never be
 * answered as one: it is a failure naming the command.
 */
test("a reply in no shape this Transport knows fails, naming the command", () => {
  expect(() => readStreams("what?", "XREAD")).toThrow(TransportError);
  expect(() => readStreams("what?", "XREAD")).toThrow(/`XREAD` answered a reply/);
  expect(() => readRange("what?", "XRANGE")).toThrow(/`XRANGE` answered a reply/);
  expect(() => readRange([["1-0"]], "XRANGE")).toThrow(TransportError);
  expect(() => readStreamInfo("what?")).toThrow(/`XINFO STREAM` answered a reply/);
});

/** A client answering in Buffers is a caller's posture, not a shape to refuse. */
test("a reply that came back as Buffers is read as the strings it holds", () => {
  const reply = [
    [Buffer.from("1-0"), [Buffer.from("entry"), Buffer.from(JSON.stringify(message))]],
  ];

  const raw = readRange(reply, "XRANGE");
  expect(raw[0]?.id).toBe("1-0");
  expect(parseEntry(raw[0]?.fields ?? [])).toEqual(message);
});

test("the envelope comes back out as the Entry that was published", () => {
  expect(parseEntry(fieldsOf(JSON.stringify(message)))).toEqual(message);
  const kick: Entry = { v: 1, type: "control", control: "kick", key: "user-7" };
  expect(parseEntry(fieldsOf(JSON.stringify(kick)))).toEqual(kick);
});

/**
 * The read path validates nothing beyond being able to make an Entry of what it read: an
 * envelope it cannot is skipped, and everything else is delivered as it stands.
 */
test("an Entry this library cannot read is no Entry at all", () => {
  expect(parseEntry([])).toBeUndefined();
  expect(parseEntry(["other", "value"])).toBeUndefined();
  expect(parseEntry(fieldsOf("{ not json"))).toBeUndefined();
  expect(parseEntry(fieldsOf(JSON.stringify({ ...message, v: 2 })))).toBeUndefined();
  expect(parseEntry(fieldsOf(JSON.stringify({ v: 1, type: "rumour" })))).toBeUndefined();
  expect(
    parseEntry(fieldsOf(JSON.stringify({ v: 1, type: "control", control: "reboot" }))),
  ).toBeUndefined();
  expect(
    parseEntry(fieldsOf(JSON.stringify({ v: 1, type: "message", channel: 42 }))),
  ).toBeUndefined();
});

test("a payload that does not match its schema is not this log's business", () => {
  const odd = { v: 1, type: "message", channel: "chat:42", event: "message", payload: "a string" };

  expect(parseEntry(fieldsOf(JSON.stringify(odd)))).toEqual(odd);
});
