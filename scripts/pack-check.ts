import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

/** What the tarball must carry. The shipped manual (ADR-0010) joins this list with its own ticket. */
const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
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

/** What may be in it at all: the built output and the three files npm ships of its own accord. */
const ALLOWED = /^(dist\/|README\.md$|LICENSE$|package\.json$)/;

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

const tests = paths.filter((path) => /\.test\.[cm]?[jt]sx?$/.test(path));
if (tests.length > 0) {
  fail(`Test files in the tarball: ${tests.join(", ")}`);
}

const missing = REQUIRED.filter((required) => !paths.includes(required));
if (missing.length > 0) {
  fail(`Missing from the tarball: ${missing.join(", ")}`);
}

/**
 * The exports map read the way Node reads it, from a consumer that resolves the package by
 * name: `./server` must load under the `react-server` condition and must throw under every
 * other one, which is the whole guard against a Client Component importing the Registry. No
 * type checker and no source-level test can observe that — only the built map can.
 */
const importsServerEntry = (conditions: string[]): { ok: boolean; output: string } => {
  const flags = conditions.map((condition) => `--conditions=${condition}`);

  try {
    const output = execFileSync(
      process.execPath,
      [...flags, "--input-type=module", "-e", "await import('@flefebvre/next-sse/server')"],
      { cwd: CONSUMER_DIR, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );

    return { ok: true, output };
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string };

    return { ok: false, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
};

const underReactServer = importsServerEntry(["react-server"]);
if (!underReactServer.ok) {
  fail(
    `The ./server entry failed to load under the react-server condition:\n${underReactServer.output}`,
  );
}

const underDefault = importsServerEntry([]);
if (underDefault.ok) {
  fail("The ./server entry loaded outside the react-server condition instead of throwing");
}
if (!underDefault.output.includes("react-server")) {
  fail(
    `The ./server entry threw outside the react-server condition, but not the guard:\n${underDefault.output}`,
  );
}

console.log(
  `Tarball OK: ${String(paths.length)} files, ${String(EXPORTS.length - 1)} subpath entries and no root export, ` +
    "and ./server loads only under react-server.",
);
