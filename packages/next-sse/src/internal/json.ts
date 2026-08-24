/** What survives `JSON.stringify` and comes back the same: the whole of what a wire payload is. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The leaves of JSON. */
type JsonPrimitive = string | number | boolean | null;

/**
 * How deep the walk goes before it takes the rest on trust.
 *
 * A payload type may be recursive — a comment with its replies is the ordinary case — and a
 * walk with no floor either loops forever or makes the compiler give up, which would turn a
 * legitimate payload into an error nobody can act on. Ten levels is far past where a wire
 * payload stops being one, and the levels below it were reached through JSON all the way down.
 */
type MAX_DEPTH = 10;

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
export type IsJson<T, Depth extends void[] = []> = [Walk<T, Depth>] extends [true] ? true : false;

/** One member of the union, on its own. Anything that is not a value JSON has is `false`. */
type Walk<T, Depth extends void[]> = Depth["length"] extends MAX_DEPTH
  ? true
  : T extends JsonPrimitive
    ? true
    : T extends readonly unknown[]
      ? WalkArray<T, [...Depth, void]>
      : T extends (...args: never[]) => unknown
        ? false
        : T extends object
          ? WalkObject<T, [...Depth, void]>
          : false;

/**
 * Every element of the array, `undefined` included, has to be JSON on its own: stringify turns
 * a missing element into `null`, and a type that says otherwise is a lie.
 */
type WalkArray<
  T extends readonly unknown[],
  Depth extends void[],
> = T extends readonly (infer Element)[] ? IsJson<Element, Depth> : false;

/**
 * Every property has to be JSON, and has to be a property JSON keeps. A symbol-keyed one is
 * not: stringify drops it, so a type that requires it would promise the client a field that
 * never arrives. A number-keyed one is kept — it comes back as a string key, which is what the
 * type says it is anyway.
 *
 * An optional property is asked about without its `undefined`: the key is omitted on the wire
 * rather than sent as `null`, which is exactly what optional means. A property whose declared
 * type includes `undefined` is not optional, and is refused.
 */
type WalkObject<T, Depth extends void[]> = {
  [Key in keyof T]-?: Key extends string | number
    ? Empty extends Pick<T, Key>
      ? IsJson<Exclude<T[Key], undefined>, Depth>
      : IsJson<T[Key], Depth>
    : false;
}[keyof T] extends true
  ? true
  : false;

/** An object with no properties: what a type with only optional ones is still assignable from. */
type Empty = Record<never, never>;
