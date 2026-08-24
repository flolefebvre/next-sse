import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = fileURLToPath(new URL("../packages/next-sse/", import.meta.url));
const CONSUMER_DIR = fileURLToPath(new URL("../tests/dist-consumer/", import.meta.url));

/** The subpaths the package promises, and nothing else: six entries and no root export. */
const EXPORTS = [
  "./server",
  "./client",
  "./transport",
  "./transport/memory",
  "./transport/redis",
  "./testing",
  "./package.json",
];

/**
 * What the tarball must carry: the built output, and the manual.
 *
 * The docs are in the package because that is what version-locks them to the code an agent reads
 * them beside (ADR-0010), and a manual that quietly stopped shipping would leave every consumer's
 * `node_modules` pointing at nothing. So the router, one page a `files` mistake would take with
 * it, and one pattern page — enough that dropping the folder, or flattening it, fails here.
 */
const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "docs/index.md",
  "docs/setup.md",
  "docs/patterns/index.md",
  "dist/server/index.js",
  "dist/server/index.d.ts",
  "dist/server/outside-react-server.js",
  "dist/server/outside-react-server.d.ts",
  "dist/client/index.js",
  "dist/client/index.d.ts",
  "dist/transport/index.js",
  "dist/transport/index.d.ts",
  "dist/transport/memory.js",
  "dist/transport/memory.d.ts",
  "dist/transport/redis.js",
  "dist/transport/redis.d.ts",
  "dist/testing/index.js",
  "dist/testing/index.d.ts",
];

/**
 * What may be in it at all: the built output, the shipped manual, and the three files npm ships
 * of its own accord. The manual is Markdown and nothing else — a stray asset or a script under
 * `docs/` is a file a consumer installs and never asked for.
 */
const ALLOWED = /^(dist\/|docs\/[\w./-]+\.md$|README\.md$|LICENSE$|package\.json$)/;

/** The subpath prefix of everything a process outside Next.js holds (ADR-0008). */
const TRANSPORT_SUBPATH = "./transport";

/** What none of it may reach. `redis` is a plain dependency and belongs there; these do not. */
const FORBIDDEN_IMPORT = /^(next|react|react-dom)(\/|$)/;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const manifest = JSON.parse(
  readFileSync(new URL("package.json", `file://${PACKAGE_DIR}`), "utf-8"),
) as {
  exports: Record<string, unknown>;
};

const declared = Object.keys(manifest.exports);
if (declared.join() !== EXPORTS.join()) {
  fail(`The exports map declares ${declared.join(", ")}, expected ${EXPORTS.join(", ")}`);
}

const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: PACKAGE_DIR, encoding: "utf-8" }),
) as [{ files: { path: string }[] }];
const paths = packed[0].files.map((file) => file.path).sort();

const stray = paths.filter((path) => !ALLOWED.test(path));
if (stray.length > 0) {
  fail(`Unexpected files in the tarball: ${stray.join(", ")}`);
}

/** Neither a test nor the harness the tests run on has any business in a consumer's install. */
const tests = paths.filter((path) => /\.(test|testkit)\.[cm]?[jt]sx?$/.test(path));
if (tests.length > 0) {
  fail(`Test files in the tarball: ${tests.join(", ")}`);
}

const missing = REQUIRED.filter((required) => !paths.includes(required));
if (missing.length > 0) {
  fail(`Missing from the tarball: ${missing.join(", ")}`);
}

/**
 * The modules the transport entries resolve to, read off the exports map rather than listed a
 * second time: a new `./transport/*` subpath is walked the day it is declared, and no one has to
 * remember this check exists. Same discipline as the reserved-name tuples — the list lives in
 * one place, and it is the map.
 */
const transportEntries = (): string[] =>
  Object.entries(manifest.exports)
    .filter(([subpath]) => subpath.startsWith(TRANSPORT_SUBPATH))
    .map(([subpath, target]) => {
      const conditions = (typeof target === "object" && target !== null ? target : {}) as Record<
        string,
        unknown
      >;
      const resolved = typeof target === "string" ? target : conditions["default"];
      if (typeof resolved !== "string") {
        return fail(`The ${subpath} entry declares no default condition to walk`);
      }

      return resolved.replace(/^\.\//, "");
    });

/**
 * Every specifier a built module imports: `from "x"`, a bare `import "x"`, and a dynamic
 * `import("x")` — which is how the zero-config path reaches node-redis, and so exactly the kind
 * of edge a graph walk must not miss.
 *
 * Block comments come out first: the doc comments the package ships name modules in prose, and
 * a sentence about React is not an import of it. The source has no line comments to strip — the
 * lint rule forbids them — and stripping those blind would eat the `//` of a `redis://` URL.
 */
const specifiersOf = (source: string): string[] => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
  ];

  return patterns
    .flatMap((pattern) => Array.from(code.matchAll(pattern), (match) => match[1] ?? ""))
    .filter((specifier) => specifier !== "");
};

/**
 * Walk the transport entries' import graph over the built output, and report every module of it
 * that reaches Next.js or React.
 *
 * The vantage is deliberate: this runs after `build`, so what is walked is what ships, not what
 * the source says. A worker Publishing into an App's log runs in a process that has neither
 * library installed (ADR-0008), and a type-only import is invisible here for the right reason —
 * it is erased from the emitted module, so it costs that process nothing.
 */
const impureTransportModules = (): string[] => {
  const offences: string[] = [];
  const visited = new Set<string>();
  const queue = transportEntries();

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);

    let source: string;
    try {
      source = readFileSync(new URL(file, `file://${PACKAGE_DIR}`), "utf-8");
    } catch {
      offences.push(`${file} is missing from the built output`);
      continue;
    }

    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith(".")) {
        queue.push(posix.normalize(posix.join(posix.dirname(file), specifier)));
      } else if (FORBIDDEN_IMPORT.test(specifier)) {
        offences.push(`${file} imports ${specifier}`);
      }
    }
  }

  return offences;
};

const impure = impureTransportModules();
if (impure.length > 0) {
  fail(`The transport entries must import no Next.js and no React: ${impure.join(", ")}`);
}

/**
 * The exports map read the way Node reads it, from a consumer that resolves the package by
 * name: `./server` must resolve to the implementation under the `react-server` condition and
 * must throw under every other one, which is the whole guard against a Client Component
 * importing the Registry. No type checker and no source-level test can observe that — only the
 * built map can.
 */
const runInConsumer = (conditions: string[], source: string): { ok: boolean; output: string } => {
  const flags = conditions.map((condition) => `--conditions=${condition}`);

  try {
    const output = execFileSync(process.execPath, [...flags, "--input-type=module", "-e", source], {
      cwd: CONSUMER_DIR,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    return { ok: true, output };
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string };

    return { ok: false, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
};

/**
 * Under `react-server` the entry is **resolved, not executed**, and that is deliberate.
 *
 * `./server` statically imports the `'use client'` entry, because `<SSEProvider>` is a Server
 * Component that renders `<SSEClientProvider>` (ADR-0002). An RSC bundler cuts the module graph
 * at that directive and never loads the client half in the server graph. Bare Node has no such
 * mechanism: it links the graph whole and reaches React's `react-server` build, which by design
 * exports no `createContext` and no hooks. Executing here would therefore fail on a package
 * that is correct, and the only way to make it pass would be to contort the shipped provider.
 *
 * What resolution still proves is what this check is for: that the map points `react-server` at
 * the implementation rather than at the throwing stub. The proof that the implementation runs
 * is in the same gate, one step later and stronger — `test:e2e` builds and boots the example
 * app, which imports `./server` through Next and renders `<SSEProvider>` for real.
 */
const RESOLVED = "process.stdout.write(import.meta.resolve('@flefebvre/next-sse/server'))";
const underReactServer = runInConsumer(["react-server"], RESOLVED);
if (!underReactServer.ok) {
  fail(
    `The ./server entry failed to resolve under the react-server condition:\n${underReactServer.output}`,
  );
}
if (!underReactServer.output.endsWith("dist/server/index.js")) {
  fail(
    `Under react-server, ./server resolves to ${underReactServer.output}, expected dist/server/index.js`,
  );
}

/**
 * The ADR-0008 guarantee itself, and the one that must keep executing: it has to throw, in
 * every layer that is not the RSC one.
 *
 * The bare run is Client-Component SSR — Next renders those in Node under React's client build,
 * with no `react-server` condition — and `browser` is what a bundler reads for the browser
 * bundle itself. A `browser`-only stub would have covered the second and missed the first,
 * which is why the failure is a throw in the module body rather than a condition in the map:
 * one guard, and it fires wherever the Registry does not belong.
 */
for (const conditions of [[], ["browser"]]) {
  const layer = conditions.length === 0 ? "Client-Component SSR" : conditions.join(", ");
  const attempt = runInConsumer(conditions, "await import('@flefebvre/next-sse/server')");
  if (attempt.ok) {
    fail(`The ./server entry loaded under ${layer} instead of throwing`);
  }
  if (!attempt.output.includes("react-server")) {
    fail(`The ./server entry threw under ${layer}, but not the guard:\n${attempt.output}`);
  }
}

console.log(
  `Tarball OK: ${String(paths.length)} files, ${String(EXPORTS.length - 1)} subpath entries and no root export, ` +
    "./server resolves to the implementation only under react-server, and the transport " +
    "entries reach no Next.js and no React.",
);
