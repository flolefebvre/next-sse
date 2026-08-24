import { expect, expectTypeOf, test } from "vitest";

import type { StandardSchemaV1 } from "../internal/standard-schema.js";

import type { Reducers } from "./handle.js";
import { upsertBy } from "./upsert-by.js";

interface Message {
  id: string;
  text: string;
}

const list: Message[] = [
  { id: "1", text: "one" },
  { id: "2", text: "two" },
];

test("an item whose key is new is appended", () => {
  expect(upsertBy("id")(list, { id: "3", text: "three" })).toEqual([
    { id: "1", text: "one" },
    { id: "2", text: "two" },
    { id: "3", text: "three" },
  ]);
});

/**
 * The duplicate case, which is the reason this exists: the Snapshot already had it, or the
 * replay carried it again, or the server action's result and its own echo both arrived. The
 * item is replaced where it stood — position is state too, and a re-append would reorder a list
 * for no reason.
 */
test("an item whose key is already there replaces it, in place", () => {
  expect(upsertBy("id")(list, { id: "1", text: "edited" })).toEqual([
    { id: "1", text: "edited" },
    { id: "2", text: "two" },
  ]);
});

test("the state it was given is left alone", () => {
  upsertBy("id")(list, { id: "1", text: "edited" });

  expect(list).toEqual([
    { id: "1", text: "one" },
    { id: "2", text: "two" },
  ]);
});

test("a key that is not one property is a function", () => {
  const byPair = upsertBy((item: { room: string; at: number }) => `${item.room}/${item.at}`);

  expect(byPair([{ room: "42", at: 1 }], { room: "42", at: 1 })).toEqual([{ room: "42", at: 1 }]);
  expect(byPair([{ room: "42", at: 1 }], { room: "7", at: 1 })).toHaveLength(2);
});

/** What the App writes: `{ message: upsertBy('id') }`, with the types coming from the Registry. */
test("it is a reducer for the event whose payload carries the key", () => {
  const reducers: Reducers<{ message: StandardSchemaV1<Message, Message> }, Message[]> = {
    message: upsertBy("id"),
  };

  expectTypeOf(reducers.message).toExtend<
    ((state: Message[], payload: Message) => Message[]) | undefined
  >();
});
