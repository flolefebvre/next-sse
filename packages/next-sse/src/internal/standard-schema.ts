import type { IsJson } from "./json.js";

/**
 * The Standard Schema v1 interface, vendored as types only.
 *
 * This is the whole of what the library needs to accept a zod 4, valibot or arktype schema,
 * and vendoring it is what keeps all three — and `@standard-schema/spec` itself — out of the
 * package's dependencies (ADR-0008). A schema is anything that carries `~standard`; the
 * library never asks which library wrote it.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/** What a validator says went wrong, and where. */
export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/** What a validator answers: the Output it produced, or the issues it found. */
export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[] };

/** What a Publish of this event takes: the schema's Input, before validation. */
export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
  Schema["~standard"]["types"]
>["input"];

/** What the wire carries and a handler receives: the schema's Output, after validation. */
export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
  Schema["~standard"]["types"]
>["output"];

/** The vendor an `asType` schema reports, so a reader can tell it apart from a real validator. */
const VENDOR = "next-sse";

/**
 * An event typed by `T` alone, with no runtime validation: the escape hatch for a payload that
 * is already trusted, or whose shape no schema library needs to restate.
 *
 * It is a real Standard Schema — `validate` hands the value straight back — so everything
 * downstream, on both sides, treats it like any other event. `T` carries the same `JsonValue`
 * bound as a schema's Output: a types-only event is still what goes on the wire.
 */
export function asType<T>(): AsTypeResult<T> {
  const schema: StandardSchemaV1<T, T> = {
    "~standard": {
      version: 1,
      vendor: VENDOR,
      validate: (value) => ({ value: value as T }),
    },
  };

  return schema as unknown as AsTypeResult<T>;
}

/**
 * What `asType<T>()` gives back: a schema, or — when `T` is not something JSON can carry — a
 * message where a schema was expected, which is how the compiler gets to say why.
 */
type AsTypeResult<T> =
  IsJson<T> extends true
    ? StandardSchemaV1<T, T>
    : "next-sse: asType<T> needs a type JSON can carry — a Date, a Map, a Set or a method is not one";

/** A payload that its event's schema refused, with everything the schema said about it. */
export class InvalidPayloadError extends Error {
  readonly issues: readonly StandardIssue[];

  constructor(channel: string, event: string, issues: readonly StandardIssue[]) {
    super(
      `next-sse: the payload published to "${channel}" as "${event}" is not valid: ` +
        issues.map(describe).join("; "),
    );
    this.name = "InvalidPayloadError";
    this.issues = issues;
  }
}

/**
 * The Output of `schema` for this payload, or an `InvalidPayloadError` naming what was wrong.
 *
 * The Publish path is the one place a payload is checked, and it is checked as Input: what
 * goes on the wire is the Output the schema produced (ADR-0006), which is what makes the
 * client's type honest without the read path validating anything. A validator is allowed to be
 * asynchronous, so this always awaits.
 */
export async function validatePayload(
  schema: StandardSchemaV1,
  channel: string,
  event: string,
  payload: unknown,
): Promise<unknown> {
  const result = await schema["~standard"].validate(payload);
  if (result.issues !== undefined) {
    throw new InvalidPayloadError(channel, event, result.issues);
  }

  return result.value;
}

/** One issue as a reader wants it: the path it happened at, then what was wrong there. */
function describe(issue: StandardIssue): string {
  const path = (issue.path ?? [])
    .map((segment) => String(typeof segment === "object" ? segment.key : segment))
    .join(".");

  return path === "" ? issue.message : `${path}: ${issue.message}`;
}
