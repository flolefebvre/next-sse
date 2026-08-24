import { expect, expectTypeOf, test } from "vitest";

import {
  assertFillablePattern,
  fillPattern,
  type ParamNames,
  type ParamsArgs,
  type ParamsOf,
} from "./pattern.js";

test("a pattern makes a Channel name out of its params", () => {
  expect(fillPattern("chat:{roomId}", { roomId: "42" })).toBe("chat:42");
  expect(fillPattern("user:{userId}:notifications", { userId: "7" })).toBe("user:7:notifications");
  expect(fillPattern("announcements", {})).toBe("announcements");
});

test("a param the caller did not give is an error, not a name with a brace in it", () => {
  expect(() => fillPattern("chat:{roomId}", {})).toThrow(/needs a "roomId" param/);
});

/** `:` separates the parts of a Channel name, so a param that holds one forges another name. */
test("a param value containing the separator is refused", () => {
  expect(() => fillPattern("chat:{roomId}", { roomId: "42:secret" })).toThrow(/must not contain/);
  expect(() => fillPattern("chat:{roomId}", { roomId: ":" })).toThrow(/must not contain ":"/);
});

test("a pattern says which params it needs, from the literal alone", () => {
  expectTypeOf<ParamNames<"chat:{roomId}">>().toEqualTypeOf<"roomId">();
  expectTypeOf<ParamNames<"user:{userId}:room:{roomId}">>().toEqualTypeOf<"userId" | "roomId">();
  expectTypeOf<ParamNames<"announcements">>().toEqualTypeOf<never>();

  expectTypeOf<ParamsOf<"chat:{roomId}">>().toEqualTypeOf<{ roomId: string }>();
  expectTypeOf<ParamsOf<"user:{userId}:room:{roomId}">>().toEqualTypeOf<{
    userId: string;
    roomId: string;
  }>();
  expectTypeOf<ParamsOf<"announcements">>().toEqualTypeOf<Record<never, string>>();
});

/** A Channel with no params is called with nothing; one with params cannot be. */
test("the call takes params exactly when the pattern has them", () => {
  expectTypeOf<ParamsArgs<"chat:{roomId}">>().toEqualTypeOf<[params: { roomId: string }]>();
  expectTypeOf<ParamsArgs<"announcements">>().toEqualTypeOf<[]>();
});

/**
 * The type level reads every `{...}` as a param; the filler only fills `\w+`. A pattern where
 * the two disagree would publish every room to one Channel, so it is refused where it is
 * written.
 */
test("a pattern whose placeholder could not be filled is refused", () => {
  expect(() => assertFillablePattern("chat:{room-id}")).toThrow(/only.*letters, digits/s);
  expect(() => assertFillablePattern("chat:{}")).toThrow(/placeholder/);
  expect(() => assertFillablePattern("chat:{ roomId }")).toThrow(/placeholder/);

  expect(() => assertFillablePattern("chat:{roomId}")).not.toThrow();
  expect(() => assertFillablePattern("user:{user_id}:inbox")).not.toThrow();
  expect(() => assertFillablePattern("announcements")).not.toThrow();
});
