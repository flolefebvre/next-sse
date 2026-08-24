import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

import { freePort } from "./ports.js";

const run = promisify(execFile);

/** Where the example app lives, and the Next.js binary its own dependencies provide. */
export const EXAMPLE_DIR = fileURLToPath(new URL("../../examples/basic/", import.meta.url));
const NEXT_BIN = join(EXAMPLE_DIR, "node_modules", ".bin", "next");
const BUILT_ENTRY = fileURLToPath(
  new URL("../../packages/next-sse/dist/server/index.js", import.meta.url),
);
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 200;
const STOP_TIMEOUT_MS = 10_000;

/** One running Instance of the example app, and the way to end it. */
export interface Instance {
  /** Where it answers, on a port of its own. */
  url: string;
  /**
   * Signal it, and do not come back until the process is gone. What comes back is how it went:
   * a scenario is expected to hand that to `assertPromptExit`, so that every one of them is a
   * witness of the Drain (ADR-0011) rather than only the scenario that is about it.
   */
  stop(): Promise<Exit>;
}

/** How a signalled Instance went. */
export interface Exit {
  /** The status it exited with — 143 for the `SIGTERM` Next.js handles — or `null`. */
  code: number | null;
  /** The signal that killed it, when nothing in the process handled the shutdown. */
  signal: NodeJS.Signals | null;
  /** Whether it had to be `SIGKILL`ed: a process that did not end its own Connections. */
  forced: boolean;
}

/**
 * A shutdown that was the App's own. It is the one claim every scenario makes for free: with
 * open Connections, a signalled `next start` exits by itself, because the Drain ends the SSE
 * responses its `server.close()` is waiting on (ADR-0011). Before Drain, every one of these
 * runs sat out the ten seconds and was killed.
 */
export function assertPromptExit(exit: Exit): void {
  if (!exit.forced) return;

  throw new Error(
    `the example app did not exit within ${String(STOP_TIMEOUT_MS)}ms of SIGTERM and had to be ` +
      `SIGKILLed: its Connections were still open`,
  );
}

/**
 * Build the example app once for the run.
 *
 * The app consumes the library the way a published consumer does — by package name, through
 * the `exports` map — so `dist/` has to be there. It is the gate's `build` step that puts it
 * there, before `test:e2e`; a run started without one fails here rather than inside a
 * scenario, where a missing module would read as a broken app.
 */
export async function buildExample(): Promise<void> {
  await assertBuiltLibrary();

  try {
    await run(NEXT_BIN, ["build"], {
      cwd: EXAMPLE_DIR,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`the example app failed to build:\n${outputOf(error)}`);
  }
}

/**
 * Start one Instance of the built example app on a free port and wait until it serves.
 *
 * Every caller owns the Instance it started and must `stop()` it in a `finally`: a scenario
 * that fails between the two would otherwise leave a `next start` holding a port for the rest
 * of the machine's day.
 */
export async function startInstance(env: Record<string, string> = {}): Promise<Instance> {
  const port = await freePort();
  const child = spawn(NEXT_BIN, ["start", "--port", String(port)], {
    cwd: EXAMPLE_DIR,
    env: { ...process.env, ...env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://127.0.0.1:${String(port)}`;
  const instance: Instance = { url, stop: () => stop(child) };

  try {
    await waitUntilServing(url, child);
  } catch (error) {
    await instance.stop();
    throw error;
  }

  return instance;
}

async function waitUntilServing(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the example app exited with code ${String(child.exitCode)} before serving`);
    }

    const response = await tryFetch(url);
    if (response?.ok === true) return;

    await delay(READY_POLL_MS);
  }

  throw new Error(`the example app did not serve ${url} within ${String(READY_TIMEOUT_MS)}ms`);
}

/**
 * One readiness poll. A process that is not listening yet refuses the connection, which is
 * the expected answer for as long as the Instance is booting, not a failure of the run.
 */
async function tryFetch(url: string): Promise<Response | undefined> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(READY_POLL_MS * 5) });
  } catch {
    return undefined;
  }
}

async function stop(child: ChildProcess): Promise<Exit> {
  const ended = (forced: boolean): Exit => ({
    code: child.exitCode,
    signal: child.signalCode,
    forced,
  });
  if (child.exitCode !== null || child.signalCode !== null) return ended(false);

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  let forced = false;
  const fallback = setTimeout(() => {
    forced = true;
    child.kill("SIGKILL");
  }, STOP_TIMEOUT_MS);

  await exited;
  clearTimeout(fallback);

  return ended(forced);
}

async function assertBuiltLibrary(): Promise<void> {
  try {
    await readFile(BUILT_ENTRY);
  } catch {
    throw new Error(
      "the e2e project needs the built output the example app imports: run `pnpm build` first",
    );
  }
}

function outputOf(error: unknown): string {
  const failed = error as { stdout?: string; stderr?: string };

  return `${failed.stdout ?? ""}${failed.stderr ?? ""}` || String(error);
}
