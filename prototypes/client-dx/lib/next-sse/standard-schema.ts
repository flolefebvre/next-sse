// PROTOTYPE. Vendored subset of the Standard Schema v1 interface (types only): this is all
// next-sse needs to accept zod / valibot / arktype payload schemas without depending on any of them.

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>
    readonly types?: { readonly input: Input; readonly output: Output } | undefined
  }
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined }> }

export type InferInput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['input']
export type InferOutput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output']

/** Types-only escape hatch: a valid Standard Schema whose validate is a passthrough (Inngest's `staticSchema<T>()`). */
export function asType<T>(): StandardSchemaV1<T, T> {
  return { '~standard': { version: 1, vendor: 'next-sse', validate: (value) => ({ value: value as T }) } }
}

export class PayloadError extends Error {
  readonly issues: ReadonlyArray<{ message: string; path?: unknown }>
  constructor(issues: ReadonlyArray<{ message: string; path?: unknown }>) {
    super(`invalid payload: ${issues.map((i) => i.message).join('; ')}`)
    this.issues = issues
  }
}

/** What publish() does: validate, throw on issues, return the Output (what goes on the wire). */
export async function validate<S extends StandardSchemaV1>(schema: S, value: unknown): Promise<InferOutput<S>> {
  const result = await schema['~standard'].validate(value)
  if (result.issues) throw new PayloadError(result.issues)
  return result.value as InferOutput<S>
}
