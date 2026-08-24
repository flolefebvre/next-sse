/** Where a param goes in a Channel pattern: `chat:{roomId}`. */
const PLACEHOLDER = /\{(\w+)\}/g;

/** Anything written between braces, whether or not it is a name a param can have. */
const ANY_PLACEHOLDER = /\{([^}]*)\}/g;

/** What a param name may be made of: exactly what the filler's placeholder recognises. */
const PARAM_NAME = /^\w+$/;

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

/**
 * The params a Channel name was made of, or `undefined` when this pattern did not make it.
 *
 * It is the exact inverse of the filler, and it is written to stay that way: the name is taken
 * apart with the same placeholders and the same separator rule, and the params it produces are
 * then filled back in and compared to the name it started from. Anything the filler could not
 * have produced — an empty param, a value carrying a `:`, a repeated param name that would have
 * had to be two different values — fails that round trip and is no match at all. Where a name is
 * genuinely ambiguous, which takes two placeholders with nothing between them, the answer is
 * whichever split fills back in: being the filler's inverse is the whole contract.
 *
 * This is what turns the Channel names on the query of a Connection into the declarations that
 * guard them. A name no pattern matches is unknown, and unknown is refused exactly like denied
 * (ADR-0003): the client must not be able to tell a Channel it may not have from one that does
 * not exist.
 */
export function matchPattern(pattern: string, name: string): Record<string, string> | undefined {
  const names: string[] = [];
  let source = "";
  let end = 0;
  for (const match of pattern.matchAll(PLACEHOLDER)) {
    source += `${escapeLiteral(pattern.slice(end, match.index))}([^${SEPARATOR}]+)`;
    names.push(match[1] ?? "");
    end = match.index + match[0].length;
  }
  source += escapeLiteral(pattern.slice(end));

  const found = new RegExp(`^${source}$`).exec(name);
  if (found === null) return undefined;

  const params: Record<string, string> = {};
  for (const [index, param] of names.entries()) {
    params[param] = found[index + 1] ?? "";
  }

  return fillPattern(pattern, params) === name ? params : undefined;
}

/** Everything a pattern holds outside its placeholders is literal text, `.` and `{` included. */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The character a witness uses where both patterns accept any character at all. */
const WITNESS_FILLER = "x";

/**
 * One step of a segment: a character the pattern spells out, the one character a param must
 * have, or the characters a param may have on top of it.
 */
type Step = { kind: "char"; char: string } | { kind: "one" } | { kind: "more" };

/**
 * A Channel name both patterns can make, or `undefined` when no name belongs to both.
 *
 * This is what makes an overlap decidable on the patterns alone, without the params neither the
 * Registry nor this function has. A param is `[^:]+` — non-empty, and it stops at the separator
 * — so the separators a name holds are the ones its pattern spells out: two patterns of
 * different segment counts can never meet, and two of the same count meet exactly where every
 * one of their segments does. A segment is then literal text and `[^:]+` holes, and whether two
 * of those share a word is the ordinary walk below, which also spells the word out.
 *
 * The answer is exact for every pattern whose param names are distinct within it, which is what
 * the type level models — `ParamsOf` reads a name once — and it is the answer the matcher would
 * give: with distinct names, anything the holes match fills back in. A pattern that names one
 * param twice constrains its holes to each other, and this walk does not carry that constraint:
 * it answers with a witness the matcher may then refuse. Erring that way is the safe one — a
 * pair is refused that could have been allowed, never the reverse — and the caller is expected
 * to check the witness before quoting it.
 */
export function collidingName(pattern: string, other: string): string | undefined {
  const segments = pattern.split(SEPARATOR);
  const others = other.split(SEPARATOR);
  if (segments.length !== others.length) return undefined;

  const shared: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const both = sharedSegment(stepsOf(segment), stepsOf(others[index] ?? ""));
    if (both === undefined) return undefined;
    shared.push(both);
  }

  return shared.join(SEPARATOR);
}

/** A segment as the steps a name has to take to match it, one per character and two per param. */
function stepsOf(segment: string): Step[] {
  const steps: Step[] = [];
  let end = 0;
  for (const match of segment.matchAll(PLACEHOLDER)) {
    for (const char of segment.slice(end, match.index)) steps.push({ kind: "char", char });
    steps.push({ kind: "one" }, { kind: "more" });
    end = match.index + match[0].length;
  }
  for (const char of segment.slice(end)) steps.push({ kind: "char", char });

  return steps;
}

/**
 * A text both segments accept, spelled out, or `undefined` when they accept none in common.
 *
 * Two positions walk together, and the only choice is what a `more` does: stand aside and let
 * the walk move on without it, or absorb whatever the other side's step asks for. Every pair of
 * positions is answered once, so the walk is over in a step per pair.
 */
function sharedSegment(left: Step[], right: Step[]): string | undefined {
  const answered = new Map<string, string | undefined>();

  const from = (here: number, there: number): string | undefined => {
    const key = `${here}:${there}`;
    if (answered.has(key)) return answered.get(key);

    const answer = walk(here, there);
    answered.set(key, answer);

    return answer;
  };

  const walk = (here: number, there: number): string | undefined => {
    if (here === left.length) return rest(right, there);
    if (there === right.length) return rest(left, here);

    const step = left[here] as Step;
    const other = right[there] as Step;
    if (step.kind === "more") {
      return from(here + 1, there) ?? taken(other, from(here, there + 1));
    }
    if (other.kind === "more") {
      return from(here, there + 1) ?? taken(step, from(here + 1, there));
    }
    if (step.kind === "char" && other.kind === "char" && step.char !== other.char) return undefined;

    return taken(step.kind === "char" ? step : other, from(here + 1, there + 1));
  };

  return from(0, 0);
}

/** What is left of one segment once the other is spent: only `more` steps may be skipped. */
function rest(steps: Step[], from: number): string | undefined {
  return steps.slice(from).every((step) => step.kind === "more") ? "" : undefined;
}

/**
 * The character this step spells out, in front of the walk that follows it. A `more` spells out
 * nothing: standing aside is what it just did, and the walk it left is already a shared text.
 */
function taken(step: Step, following: string | undefined): string | undefined {
  if (following === undefined) return undefined;
  if (step.kind === "more") return following;

  return (step.kind === "char" ? step.char : WITNESS_FILLER) + following;
}

/**
 * Refuse a pattern whose placeholders the filler would not fill.
 *
 * `{room-id}` reads like a param and the type level infers one from it, but the filler only
 * recognises `\w+`, so the brace would survive into the Channel name and every room would
 * publish to the same one. The two grammars have to agree, and the declaration is where the
 * App hears that they do not.
 */
export function assertFillablePattern(pattern: string): void {
  for (const match of pattern.matchAll(ANY_PLACEHOLDER)) {
    const name = match[1] ?? "";
    if (!PARAM_NAME.test(name)) {
      throw new Error(
        `The Channel "${pattern}" has a "{${name}}" placeholder, and a param name may only ` +
          `hold letters, digits and "_": nothing else is filled in, and the braces would ` +
          `reach the wire.`,
      );
    }
  }
}
