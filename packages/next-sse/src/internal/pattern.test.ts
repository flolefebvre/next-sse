import { expect, expectTypeOf, test } from "vitest";

import {
  assertFillablePattern,
  collidingName,
  fillPattern,
  matchPattern,
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

/** The matcher is the filler read backwards: the same names, the same separator rule. */
test("a Channel name is taken apart by the pattern that made it", () => {
  expect(matchPattern("chat:{roomId}", "chat:42")).toEqual({ roomId: "42" });
  expect(matchPattern("user:{userId}:room:{roomId}", "user:7:room:42")).toEqual({
    userId: "7",
    roomId: "42",
  });
  expect(matchPattern("announcements", "announcements")).toEqual({});
});

test("a name another pattern made, or no pattern made, matches nothing", () => {
  expect(matchPattern("chat:{roomId}", "presence:42")).toBeUndefined();
  expect(matchPattern("chat:{roomId}", "chat:42:secret")).toBeUndefined();
  expect(matchPattern("chat:{roomId}", "chat:")).toBeUndefined();
  expect(matchPattern("chat:{roomId}", "chat")).toBeUndefined();
  expect(matchPattern("announcements", "announcements:42")).toBeUndefined();
  expect(matchPattern("user:{userId}:inbox", "user:7:outbox")).toBeUndefined();
});

/**
 * Every match is checked by filling the pattern back in, so what the matcher hands back always
 * makes that very name again. A pattern that names one param twice matches only a name where
 * both parts are the same value, because that is the only name the filler could have made.
 */
test("only params the filler could have produced are a match", () => {
  expect(matchPattern("room:{id}:{id}", "room:42:42")).toEqual({ id: "42" });
  expect(matchPattern("room:{id}:{id}", "room:42:7")).toBeUndefined();
});

/**
 * Two placeholders with nothing between them make a name that several sets of params could
 * have produced. The matcher answers with one of them — the one that fills back in — rather
 * than with nothing: a pattern like this is a declaration the App should not have written, and
 * the honest thing here is to be the filler's inverse, not to invent a second rule about it.
 */
test("adjacent placeholders match on the split that fills back in", () => {
  const params = matchPattern("{a}{b}", "xy");

  expect(params).toBeDefined();
  expect(fillPattern("{a}{b}", params ?? {})).toBe("xy");
});

/** A pattern's literal text is text: a name that happens to read like a regex matches nothing. */
test("the literal parts of a pattern are not a pattern of their own", () => {
  expect(matchPattern("a.c:{id}", "abc:42")).toBeUndefined();
  expect(matchPattern("a.c:{id}", "a.c:42")).toEqual({ id: "42" });
});

/**
 * A param stops at the separator, so the separators a name holds are the ones its pattern spells
 * out: two patterns that ask for a different number of parts have no name in common, whatever
 * their params are.
 */
test("patterns of different segment counts can never make the same name", () => {
  expect(collidingName("chat:{roomId}", "announcements")).toBeUndefined();
  expect(collidingName("chat:{roomId}", "chat:{roomId}:typing")).toBeUndefined();
  expect(collidingName("{a}", "{a}:{b}")).toBeUndefined();
});

/** The witness is a name both patterns make, and both matchers take apart again. */
test("two patterns that can make one name answer with it", () => {
  const collisions = [
    ["user:{id}", "{kind}:7"],
    ["chat:{roomId}", "chat:admin"],
    ["chat:{roomId}", "chat:{room}"],
    ["{a}:{b}", "x:y"],
    ["a{id}c", "{head}bc"],
    ["user:{id}:inbox", "user:7:{box}"],
  ] as const;

  for (const [pattern, other] of collisions) {
    const name = collidingName(pattern, other);

    expect(name, `${pattern} / ${other}`).toBeDefined();
    expect(matchPattern(pattern, name ?? ""), `${pattern} / ${name}`).toBeDefined();
    expect(matchPattern(other, name ?? ""), `${other} / ${name}`).toBeDefined();
  }
});

test("patterns whose literal parts disagree have no name in common", () => {
  expect(collidingName("chat:{roomId}", "presence:{roomId}")).toBeUndefined();
  expect(collidingName("user:{id}:inbox", "user:{id}:outbox")).toBeUndefined();
  expect(collidingName("announcements", "audit")).toBeUndefined();
  expect(collidingName("a{id}c", "a{id}d")).toBeUndefined();
});

/** Two names of one Channel: the same literal pattern twice, which is the same Channel. */
test("a pattern collides with itself", () => {
  expect(collidingName("announcements", "announcements")).toBe("announcements");
  expect(collidingName("user:{id}", "user:{id}")).toBeDefined();
});

/** A param is `[^:]+`: it takes at least one character, so an empty part is nobody's name. */
test("a param never stands for an empty part of a name", () => {
  expect(collidingName("chat:{roomId}", "chat:")).toBeUndefined();
  expect(collidingName("{id}", "")).toBeUndefined();
});

/**
 * A pattern that names one param twice ties its parts to each other, and the walk does not carry
 * that tie: it answers with a witness the matcher then refuses. The pair is refused all the same
 * — erring towards a Registry the App has to rename is the safe direction — and the caller is
 * what checks the witness before quoting it.
 */
test("a param named twice is answered conservatively", () => {
  const name = collidingName("{a}:{a}", "{b}:{b}x");

  expect(name).toBeDefined();
  expect(matchPattern("{a}:{a}", name ?? "")).toBeUndefined();
});
