/** Where a param goes in a Channel pattern: `chat:{roomId}`. */
const PLACEHOLDER = /\{(\w+)\}/g;

/** The separator a pattern is written with, and so the one character a param value cannot hold. */
const SEPARATOR = ":";

/** The names a pattern asks for, read straight off the literal: `chat:{roomId}` → `"roomId"`. */
export type ParamNames<Pattern extends string> =
  Pattern extends `${string}{${infer Name}}${infer Rest}` ? Name | ParamNames<Rest> : never;

/** What a pattern needs to become a Channel name: one string per `{name}` it holds. */
export type ParamsOf<Pattern extends string> = { [Name in ParamNames<Pattern>]: string };

/**
 * How a Channel is called: with its params, or with nothing at all when its pattern has none.
 * `announcements()` reads the way it should, rather than `announcements({})`.
 */
export type ParamsArgs<Pattern extends string> = [ParamNames<Pattern>] extends [never]
  ? []
  : [params: ParamsOf<Pattern>];

/**
 * The Channel name a pattern makes with these params: every `{name}` replaced by the param of
 * that name. A param the caller did not give is an error rather than a Channel name with a
 * brace in it, which would reach the wire and silently match nothing.
 *
 * Both sides fill patterns — a server Handle to Publish, a client hook to subscribe — and they
 * have to agree to the character, because the name one writes is the name the other listens
 * for. So there is one filler, and it lives under `internal` where neither side owns it.
 *
 * A value carrying a `:` is refused. The separator is what tells one segment of a name from
 * the next, so `chat:{roomId}` filled with `1:2` is the name another pattern could have made:
 * a Publish would land on a Channel nobody meant, and Authorize would have been asked about a
 * different one. There is no escaping to get right — the character is simply not allowed.
 */
export function fillPattern(pattern: string, params: Record<string, string>): string {
  return pattern.replace(PLACEHOLDER, (_, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`The Channel "${pattern}" needs a "${name}" param, and none was given.`);
    }
    if (value.includes(SEPARATOR)) {
      throw new Error(
        `The "${name}" param of the Channel "${pattern}" must not contain "${SEPARATOR}", ` +
          `and "${value}" does: it is what separates one part of a Channel name from the next.`,
      );
    }

    return value;
  });
}
