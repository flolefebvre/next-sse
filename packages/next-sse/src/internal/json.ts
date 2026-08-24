/** What survives `JSON.stringify` and comes back the same: the whole of what a wire payload is. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The leaves of JSON. */
type JsonPrimitive = string | number | boolean | null;

/**
 * Whether `T` is honest JSON: `true` when every value it can hold survives the wire unchanged.
 *
 * This is a structural walk rather than `T extends JsonValue`, and it has to be. An App that
 * writes `interface Message { id: string }` — the common case with `asType<T>()` — has a type
 * with no implicit index signature, so it is not assignable to `{ [key: string]: JsonValue }`
 * however plain its fields are. Walking the keys asks the question that actually matters:
 * would `JSON.parse(JSON.stringify(value))` still be a `T`?
 *
 * The walk distributes over unions, and the answer is gathered back here: a union is JSON only
 * when every member of it is.
 */
export type IsJson<T> = [Walk<T>] extends [true] ? true : false;

/** One member of the union, on its own. Anything that is not a value JSON has is `false`. */
type Walk<T> = T extends JsonPrimitive
  ? true
  : T extends readonly unknown[]
    ? WalkArray<T>
    : T extends (...args: never[]) => unknown
      ? false
      : T extends object
        ? WalkObject<T>
        : false;

/**
 * Every element of the array, `undefined` included, has to be JSON on its own: stringify turns
 * a missing element into `null`, and a type that says otherwise is a lie.
 */
type WalkArray<T extends readonly unknown[]> = T extends readonly (infer Element)[]
  ? IsJson<Element>
  : false;

/**
 * Every property has to be JSON. An optional one is asked about without its `undefined`: the
 * key is omitted on the wire rather than sent as `null`, which is exactly what optional means.
 * A property whose declared type includes `undefined` is not optional, and is refused.
 */
type WalkObject<T> = {
  [Key in keyof T]-?: Empty extends Pick<T, Key>
    ? IsJson<Exclude<T[Key], undefined>>
    : IsJson<T[Key]>;
}[keyof T] extends true
  ? true
  : false;

/** An object with no properties: what a type with only optional ones is still assignable from. */
type Empty = Record<never, never>;
