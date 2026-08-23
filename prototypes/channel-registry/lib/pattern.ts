// PROTOTYPE. Pattern grammar: `{name}` placeholders, literal separators, a param never contains ':'.
// Type level: params inferred from the pattern literal. Runtime: fill (publish side) and parse (connect side).

export type ParamNames<P extends string> = P extends `${infer _Head}{${infer Name}}${infer Rest}` ? Name | ParamNames<Rest> : never

export type Params<P extends string> = { [K in ParamNames<P>]: string }

export type Interpolate<P extends string> = P extends `${infer Head}{${infer _Name}}${infer Rest}` ? `${Head}${string}${Interpolate<Rest>}` : P

/** `(params)` when the pattern has placeholders, `()` otherwise. */
export type ParamsArgs<P extends string> = [ParamNames<P>] extends [never] ? [] : [params: Params<P>]

const PLACEHOLDER = /\{(\w+)\}/g
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function fill<P extends string>(pattern: P, params: Record<string, string> = {}): Interpolate<P> {
  return pattern.replace(PLACEHOLDER, (_, key: string) => {
    const value = params[key]
    if (value === undefined) throw new Error(`missing param "${key}" for pattern "${pattern}"`)
    if (value.includes(':')) throw new Error(`param "${key}" must not contain ':' (got "${value}")`)
    return value
  }) as Interpolate<P>
}

export function compile(pattern: string): { names: string[]; regex: RegExp } {
  const names: string[] = []
  let source = '^'
  let last = 0
  for (const match of pattern.matchAll(PLACEHOLDER)) {
    source += escape(pattern.slice(last, match.index)) + '([^:]+)'
    names.push(match[1]!)
    last = match.index + match[0].length
  }
  source += escape(pattern.slice(last)) + '$'
  return { names, regex: new RegExp(source) }
}

export function parse<P extends string>(pattern: P, name: string): Params<P> | null {
  const { names, regex } = compile(pattern)
  const match = regex.exec(name)
  if (!match) return null
  const params: Record<string, string> = {}
  names.forEach((key, i) => (params[key] = match[i + 1]!))
  return params as Params<P>
}
