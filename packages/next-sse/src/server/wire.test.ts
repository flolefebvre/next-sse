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

test("a Message is framed as its Cursor, its event name and its payload as JSON", () => {
  expect(text(encodeMessage(stored()))).toBe(
    'id: abcd1234-1\nevent: message\ndata: {"text":"hello"}\n\n',
  );
});

test("a Message whose payload has no JSON form is framed as null rather than as nothing", () => {
  expect(text(encodeMessage(stored({ payload: undefined })))).toBe(
    "id: abcd1234-1\nevent: message\ndata: null\n\n",
  );
});

test("a payload with line breaks stays one data line, because JSON escapes them", () => {
  expect(text(encodeMessage(stored({ payload: { text: "one\ntwo" } })))).toBe(
    'id: abcd1234-1\nevent: message\ndata: {"text":"one\\ntwo"}\n\n',
  );
});

test("line breaks in an event name or a Cursor cannot open a field of their own", () => {
  expect(text(encodeMessage(stored({ event: "message\ndata: injected", cursor: "a\r\n-1" })))).toBe(
    'id: a-1\nevent: messagedata: injected\ndata: {"text":"hello"}\n\n',
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
