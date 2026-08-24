import type { Retention } from "../transport/index.js";

/**
 * What one environment configures, in the shape the Transport factories take it (ADR-0006).
 * `url` is what decides which Transport an App gets at all: given, the Redis Transport; not
 * given, the Memory one.
 */
export interface TransportEnvOptions {
  /** `REDIS_URL`: the server the Redis Transport connects to. */
  url?: string;
  /** `NEXT_SSE_PREFIX`: the per-App namespace, verbatim. */
  prefix?: string;
  /** `NEXT_SSE_RETENTION_WINDOW` and `NEXT_SSE_RETENTION_CAP`, when either is given. */
  retention?: Retention;
  /** `NEXT_SSE_OPERATION_TIMEOUT`: how long one operation may take, in milliseconds. */
  operationTimeout?: number;
  /** `NEXT_SSE_DEBUG`: whether the Transport narrates what its reader is doing. */
  debug?: boolean;
}

const BOOLEANS = new Map([
  ["1", true],
  ["true", true],
  ["0", false],
  ["false", false],
]);

/**
 * Read one environment into the options the Transport factories take. This is the whole
 * variable table of ADR-0006, and the only place it lives:
 *
 * - `REDIS_URL` → `url`
 * - `NEXT_SSE_PREFIX` → `prefix`, verbatim
 * - `NEXT_SSE_RETENTION_WINDOW` → `retention.window`, in seconds
 * - `NEXT_SSE_RETENTION_CAP` → `retention.cap`, in entries
 * - `NEXT_SSE_OPERATION_TIMEOUT` → `operationTimeout`, in milliseconds
 * - `NEXT_SSE_DEBUG` → `debug`, one of `1`, `true`, `0` and `false`
 *
 * A variable that is unset or empty is not given, and the option keeps its default: a
 * deployment tool that materialises an unset variable as `""` configures nothing by accident.
 * The retention names carry no `REDIS` because retention applies to both shipped Transports;
 * `retention` is absent altogether when neither of its variables is given, so that a factory
 * cannot tell "no retention configured" from "a window of nothing".
 *
 * The environment is a table of strings, so a value that is no whole number, or no boolean, is
 * rejected here, naming the variable — that is what its author can act on. Nothing else is
 * checked: what this function could parse is handed to the factory as it is, and the factory
 * stays the one place that says what an option accepts.
 *
 * Every variable is parsed before `REDIS_URL` is looked at, so an unusable value is reported on
 * a host that has no `REDIS_URL` too, rather than lying dormant until the day one is set.
 */
export function transportOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): TransportEnvOptions {
  const prefix = given(env, "NEXT_SSE_PREFIX");
  const window = integer(env, "NEXT_SSE_RETENTION_WINDOW");
  const cap = integer(env, "NEXT_SSE_RETENTION_CAP");
  const operationTimeout = integer(env, "NEXT_SSE_OPERATION_TIMEOUT");
  const debug = boolean(env, "NEXT_SSE_DEBUG");
  const url = given(env, "REDIS_URL");

  const retention: Retention = {};
  if (window !== undefined) retention.window = window;
  if (cap !== undefined) retention.cap = cap;

  return {
    ...(url === undefined ? {} : { url }),
    ...(prefix === undefined ? {} : { prefix }),
    ...(window === undefined && cap === undefined ? {} : { retention }),
    ...(operationTimeout === undefined ? {} : { operationTimeout }),
    ...(debug === undefined ? {} : { debug }),
  };
}

/** What a variable holds, or `undefined` when it is unset or empty. */
function given(env: NodeJS.ProcessEnv, variable: string): string | undefined {
  const value = env[variable];

  return value === undefined || value === "" ? undefined : value;
}

function integer(env: NodeJS.ProcessEnv, variable: string): number | undefined {
  const value = given(env, variable);
  if (value === undefined) return undefined;

  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`\`${variable}\` must be a whole number, was \`${value}\``);
  }

  return parsed;
}

function boolean(env: NodeJS.ProcessEnv, variable: string): boolean | undefined {
  const value = given(env, variable);
  if (value === undefined) return undefined;

  const parsed = BOOLEANS.get(value.toLowerCase());
  if (parsed === undefined) {
    throw new Error(
      `\`${variable}\` must be one of \`1\`, \`true\`, \`0\` and \`false\`, was \`${value}\``,
    );
  }

  return parsed;
}
