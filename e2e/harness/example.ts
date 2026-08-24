import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

import { inject } from "vitest";

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
  /** That port, for the one scenario that wants an Instance back at the same address. */
  port: number;
  /**
   * Signal it, and do not come back until the process is gone. What comes back is how it went:
   * a scenario is expected to hand that to `assertPromptExit`, so that every one of them is a
   * witness of the Drain (ADR-0011) rather than only the scenario that is about it.
   */
  stop(): Promise<Exit>;
  /**
   * Kill it where it stands, and do not come back until the process is gone: no signal it can
   * handle, no Drain, no goodbye to the Connections it holds — the crash, as against the
   * orchestrated shutdown `stop()` is. There is no `Exit` to read: a process that was given no
   * say in its own end makes no claim worth asserting.
   */
  kill(): Promise<void>;
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
  if (exit.forced) {
    throw new Error(
      `the example app did not exit within ${String(STOP_TIMEOUT_MS)}ms of SIGTERM and had to ` +
        `be SIGKILLed: its Connections were still open`,
    );
  }
  if (exit.signal !== null) {
    throw new Error(
      `the example app was killed by ${exit.signal} rather than handling it: a handled ` +
        `SIGTERM is an exit code, never a signal`,
    );
  }
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
 * One App of the run, as its Instances are configured: the run's server, under a Prefix nothing
 * else uses.
 *
 * The Prefix is the whole of the isolation, and it is enough — it is what keeps two Apps apart
 * on a shared server anyway (ADR-0006). A scenario that wants two Instances of one App hands
 * this same value to both; two scenarios never see each other's log.
 */
export interface App {
  /** What every Instance of this App is started with, on top of its own environment. */
  env: Record<string, string>;
}

/** A fresh App on the run's server: a Prefix of its own, and nothing else configured. */
export function anApp(): App {
  return {
    env: {
      REDIS_URL: inject("redisUrl"),
      NEXT_SSE_PREFIX: `next-sse-e2e-${randomUUID().slice(0, 8)}`,
    },
  };
}

/**
 * Start one Instance of the built example app on a free port and wait until it serves.
 *
 * It is an Instance of a fresh App unless the caller brings one, which is what a scenario about
 * a single Instance wants: a log with nobody else on it. Everything the App configures can be
 * overridden per Instance through `env`, so a scenario needing a short lifetime or a fast
 * heartbeat sets it there rather than in a branch of the library (ADR-0009).
 *
 * Every caller owns the Instance it started and must `stop()` it in a `finally`: a scenario
 * that fails between the two would otherwise leave a `next start` holding a port for the rest
 * of the machine's day.
 *
 * The port is the kernel's unless a caller names one, which only the scenario about a process
 * coming back at the address it died on ever does (#45): every other Instance of every run takes
 * a free port, so runs on one machine never collide.
 */
export async function startInstance(
  app: App = anApp(),
  env: Record<string, string> = {},
  onPort?: number,
): Promise<Instance> {
  const port = onPort ?? (await freePort());
  const child = spawn(NEXT_BIN, ["start", "--port", String(port)], {
    cwd: EXAMPLE_DIR,
    env: { ...process.env, ...app.env, ...env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://127.0.0.1:${String(port)}`;
  const instance: Instance = { url, port, stop: () => stop(child), kill: () => kill(child) };

  try {
    await waitUntilServing(url, child);
  } catch (error) {
    await instance.stop();
    throw error;
  }

  return instance;
}

/** Two Instances of one App, and the way both go. */
export interface TwoInstances {
  /** The Instance a client is on. */
  here: Instance;
  /** Another Instance of the same App, which may hold Connections of its own. */
  there: Instance;
  /**
   * Signal both and assert each ended its own Connections. Stopping one of them earlier — as a
   * failover scenario does — costs nothing here: a process that is already gone is not
   * signalled twice, and the exit it reported the first time is the one asserted again.
   */
  stop(): Promise<void>;
}

/**
 * Two Instances of one App, on one server: two `next start` processes on ports of their own,
 * sharing a Prefix and nothing else.
 *
 * That is the topology this library exists for — two pods behind a load balancer — and the one
 * the integration project can only approximate in a single process (ADR-0009): here each
 * Instance has its own module registry, its own `globalThis`, its own Connection table and its
 * own subscription, exactly as a deployment does. They are booted together because a run pays
 * for every boot in wall-clock and no scenario needs one before the other.
 */
export async function twoInstances(app: App = anApp()): Promise<TwoInstances> {
  const [here, there] = await bothStarted(app);

  return {
    here,
    there,
    stop: async () => {
      const exits = await Promise.all([here.stop(), there.stop()]);
      for (const exit of exits) assertPromptExit(exit);
    },
  };
}

/**
 * Both Instances up, or neither: the one that did start is signalled before the failure is
 * raised, so a boot that goes wrong leaves no `next start` behind.
 */
async function bothStarted(app: App): Promise<[Instance, Instance]> {
  const started = await Promise.allSettled([startInstance(app), startInstance(app)]);
  const running = started.flatMap((one) => (one.status === "fulfilled" ? [one.value] : []));
  const failed = started.find((one) => one.status === "rejected");

  if (failed !== undefined) {
    await Promise.all(running.map((instance) => instance.stop()));
    throw failed.reason as Error;
  }

  return running as [Instance, Instance];
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
  /**
   * A `SIGKILL` is a forced end whoever pulled the trigger, including a `stop()` that gave up
   * before this one was called: reading it off the process rather than off this call's own timer
   * is what keeps a second `stop()` of an Instance that had to be killed reporting the reason it
   * was, instead of accusing it of not handling a signal it never received.
   */
  const ended = (forced: boolean): Exit => ({
    code: child.exitCode,
    signal: child.signalCode,
    forced: forced || child.signalCode === "SIGKILL",
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

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
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
