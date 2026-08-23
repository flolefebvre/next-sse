/** Where a param goes in a Channel pattern: `chat:{roomId}`. */
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * The Channel name a pattern makes with these params: every `{name}` replaced by the param of
 * that name. A param the caller did not give is an error rather than a Channel name with a
 * brace in it, which would reach the wire and silently match nothing.
 *
 * Both sides fill patterns — a server Handle to Publish, a client hook to subscribe — and they
 * have to agree to the character, because the name one writes is the name the other listens
 * for. So there is one filler, and it lives under `internal` where neither side owns it.
 */
export function fillPattern(pattern: string, params: Record<string, string>): string {
  return pattern.replace(PLACEHOLDER, (_, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`The Channel "${pattern}" needs a "${name}" param, and none was given.`);
    }

    return value;
  });
}
