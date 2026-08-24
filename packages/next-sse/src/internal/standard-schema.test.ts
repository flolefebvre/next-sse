import { type } from "arktype";
import * as v from "valibot";
import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import type { IsJson } from "./json.js";
import {
  asType,
  InvalidPayloadError,
  validatePayload,
  type InferInput,
  type InferOutput,
  type StandardSchemaV1,
} from "./standard-schema.js";

/**
 * The three schema libraries the spec names, held here as plain values: the point of Standard
 * Schema is that the library never learns which one wrote a schema, and this file is where
 * that claim is checked against the real packages rather than against a hand-written stub.
 * They are devDependencies of the workspace, never of the package (ADR-0008).
 */
const zodMessage = z.object({ text: z.string() });
const valibotMessage = v.object({ text: v.string() });
const arktypeMessage = type({ text: "string" });

test("a zod 4 schema validates and produces its Output", async () => {
  await expect(validatePayload(zodMessage, "chat:1", "message", { text: "hi" })).resolves.toEqual({
    text: "hi",
  });
});

test("a valibot schema validates and produces its Output", async () => {
  await expect(
    validatePayload(valibotMessage, "chat:1", "message", { text: "hi" }),
  ).resolves.toEqual({ text: "hi" });
});

test("an arktype schema validates and produces its Output", async () => {
  await expect(
    validatePayload(arktypeMessage, "chat:1", "message", { text: "hi" }),
  ).resolves.toEqual({ text: "hi" });
});

/** What goes on the wire is the Output, not what the caller passed (ADR-0006). */
test("a schema that transforms puts what it produced on the wire", async () => {
  const trimmed = z.object({ text: z.string().trim() });

  await expect(validatePayload(trimmed, "chat:1", "message", { text: "  hi  " })).resolves.toEqual({
    text: "hi",
  });
});

test("an invalid payload rejects with the issues the schema found", async () => {
  const rejected = validatePayload(zodMessage, "chat:1", "message", { text: 42 });

  await expect(rejected).rejects.toBeInstanceOf(InvalidPayloadError);
  const error = await rejected.then(
    () => undefined,
    (thrown: InvalidPayloadError) => thrown,
  );
  expect(error).toBeDefined();
  expect(error?.issues.length).toBeGreaterThan(0);
  expect(error?.message).toContain("chat:1");
  expect(error?.message).toContain("message");
  expect(error?.message).toContain("text");
});

/** The spec allows an asynchronous validator, so the publish path always awaits. */
test("an asynchronous validator is awaited", async () => {
  const slow: StandardSchemaV1<string, string> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) =>
        Promise.resolve(
          typeof value === "string" ? { value } : { issues: [{ message: "not a string" }] },
        ),
    },
  };

  await expect(validatePayload(slow, "chat:1", "message", "hi")).resolves.toBe("hi");
  await expect(validatePayload(slow, "chat:1", "message", 1)).rejects.toBeInstanceOf(
    InvalidPayloadError,
  );
});

test("asType is a Standard Schema of this library that validates nothing", async () => {
  const schema = asType<{ text: string }>();

  expect(schema["~standard"].vendor).toBe("next-sse");
  expect(schema["~standard"].version).toBe(1);
  await expect(validatePayload(schema, "chat:1", "message", { nothing: true })).resolves.toEqual({
    nothing: true,
  });
});

test("the payload a Publish takes is the schema's Input, and the wire carries its Output", () => {
  const coerced = z.object({ at: z.coerce.number() });
  expect(coerced["~standard"].vendor).toBe("zod");

  expectTypeOf<InferInput<typeof coerced>>().toEqualTypeOf<{ at: unknown }>();
  expectTypeOf<InferOutput<typeof coerced>>().toEqualTypeOf<{ at: number }>();
  expectTypeOf<InferOutput<typeof zodMessage>>().toEqualTypeOf<{ text: string }>();
  expectTypeOf<InferOutput<typeof valibotMessage>>().toEqualTypeOf<{ text: string }>();
  expectTypeOf<InferOutput<typeof arktypeMessage>>().toEqualTypeOf<{ text: string }>();
});

/**
 * The bound is a structural walk, not assignability to a `JsonValue` alias, and this is why:
 * an `interface` has no implicit index signature, so the alias would reject the plainest
 * payload an App can write.
 */
interface Message {
  id: string;
  text: string;
  tags: readonly string[];
  edited?: boolean;
}

test("what JSON can carry is what the bound accepts", () => {
  expectTypeOf<IsJson<Message>>().toEqualTypeOf<true>();
  expectTypeOf<IsJson<{ text: string }>>().toEqualTypeOf<true>();
  expectTypeOf<IsJson<readonly string[]>>().toEqualTypeOf<true>();
  expectTypeOf<IsJson<{ nested: { deep: number[] } }>>().toEqualTypeOf<true>();
  expectTypeOf<IsJson<string>>().toEqualTypeOf<true>();
  expectTypeOf<IsJson<null>>().toEqualTypeOf<true>();
  expectTypeOf<IsJson<Record<string, number>>>().toEqualTypeOf<true>();
});

test("what JSON cannot carry honestly is what the bound rejects", () => {
  expectTypeOf<IsJson<Date>>().toEqualTypeOf<false>();
  expectTypeOf<IsJson<{ at: Date }>>().toEqualTypeOf<false>();
  expectTypeOf<IsJson<Map<string, string>>>().toEqualTypeOf<false>();
  expectTypeOf<IsJson<Set<string>>>().toEqualTypeOf<false>();
  expectTypeOf<IsJson<{ run: () => void }>>().toEqualTypeOf<false>();
  expectTypeOf<IsJson<bigint>>().toEqualTypeOf<false>();
  expectTypeOf<IsJson<symbol>>().toEqualTypeOf<false>();
});

/** `undefined` follows `JSON.stringify`: omitted where a key may be missing, a lie anywhere else. */
test("undefined is JSON exactly where stringify omits it", () => {
  expectTypeOf<IsJson<{ edited?: boolean }>>().toEqualTypeOf<true>();
  expectTypeOf<IsJson<undefined>>().toEqualTypeOf<false>();
  expectTypeOf<IsJson<string | undefined>>().toEqualTypeOf<false>();
  expectTypeOf<IsJson<(string | undefined)[]>>().toEqualTypeOf<false>();
  expectTypeOf<IsJson<{ edited: boolean | undefined }>>().toEqualTypeOf<false>();
});

test("asType takes the same bound as a schema's Output", () => {
  expectTypeOf(asType<Message>()).toEqualTypeOf<StandardSchemaV1<Message, Message>>();

  const rejected = asType<{ at: Date }>();
  expectTypeOf(rejected).toBeString();
});
