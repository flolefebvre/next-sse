import { expect, test } from "vitest";

import { encodeControl, encodeMessage, encodeRetry, type StoredMessage } from "./wire.js";

const decoder = new TextDecoder();
const text = (bytes: Uint8Array): string => decoder.decode(bytes);

const stored = (overrides: Partial<StoredMessage> = {}): StoredMessage => ({
  v: 1,
  type: "message",
  channel: "chat:42",
  event: "message",
  payload: { text: "hello" },
  cursor: "abcd1234-1",
  ...overrides,
});

test("a Message is framed as its Cursor and the envelope its Channel, event and payload make", () => {
  expect(text(encodeMessage(stored()))).toBe(
    'id: abcd1234-1\ndata: {"channel":"chat:42","event":"message","payload":{"text":"hello"}}\n\n',
  );
});

/**
 * The rule that keeps Messages and Control events apart: only Control events are named blocks.
 * A Channel free to declare an event called `caught-up` is the point of it.
 */
test("a Message carries no event name on the wire, whatever its event is called", () => {
  const framed = text(encodeMessage(stored({ event: "caught-up" })));

  expect(framed).not.toContain("event: ");
  expect(framed).toBe(
    'id: abcd1234-1\ndata: {"channel":"chat:42","event":"caught-up","payload":{"text":"hello"}}\n\n',
  );
});

test("a Message with no payload keeps its Channel and its event name", () => {
  expect(text(encodeMessage(stored({ payload: undefined })))).toBe(
    'id: abcd1234-1\ndata: {"channel":"chat:42","event":"message"}\n\n',
  );
});

test("a payload with line breaks stays one data line, because JSON escapes them", () => {
  expect(text(encodeMessage(stored({ payload: { text: "one\ntwo" } })))).toBe(
    'id: abcd1234-1\ndata: {"channel":"chat:42","event":"message","payload":{"text":"one\\ntwo"}}\n\n',
  );
});

/**
 * The Channel and the event name are inside JSON now, so the escaping covers them; the Cursor
 * is the one field still written as raw text and the one that still has to be cut.
 */
test("line breaks cannot open a field of their own, in the Cursor or in the envelope", () => {
  expect(text(encodeMessage(stored({ event: "message\ndata: injected", cursor: "a\r\n-1" })))).toBe(
    'id: a-1\ndata: {"channel":"chat:42","event":"message\\ndata: injected","payload":{"text":"hello"}}\n\n',
  );
});

test("a Control event carries an event name and data, and never an id", () => {
  const ready = text(encodeControl("ready", { cursor: "abcd1234-0", refused: [] }));

  expect(ready).toBe('event: ready\ndata: {"cursor":"abcd1234-0","refused":[]}\n\n');
  expect(ready).not.toContain("id:");
});

test("a Control event with nothing to say still carries a data line, or no event is dispatched", () => {
  expect(text(encodeControl("caught-up"))).toBe("event: caught-up\ndata: {}\n\n");
});

test("the retry field is its own block", () => {
  expect(text(encodeRetry(3000))).toBe("retry: 3000\n\n");
});
