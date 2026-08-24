import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How many times a start whose host port Docker refused is taken from the top, fresh ports and
 * all. Three, because the window it loses in is milliseconds wide: a start that loses it three
 * times running is not a race any more, and has to be seen rather than absorbed.
 */
export const START_ATTEMPTS = 3;

/**
 * How old a turn has to be before it is treated as nobody's, whatever it says about its holder.
 * Well above the 180 s a topology is given to come up (`TOPOLOGY_TIMEOUT_MS`, and the 120 s
 * `STARTUP_TIMEOUT_MS` inside it), so that no start that is merely slow is ever cut in front of;
 * this is the second rule, behind a holder whose process is gone, and covers only the case a
 * dead pid cannot — a pid reused by an unrelated process.
 */
export const ABANDONED_AFTER_MS = 600_000;

/** How often a waiting starter looks again. Fixed: the wait is for a peer, not for a backoff. */
const POLL_MS = 150;

/** What Docker says when the host port a container asks for was taken between reserve and run. */
const PORT_TAKEN = "port is already allocated";

/**
 * Where the turn is written. Under `node_modules`, so it is per checkout, never committed, and
 * gone with an install — and outside `tests/`, which holds the code that takes turns and not
 * the artefacts of a run.
 */
const LOCK_FILE = fileURLToPath(
  new URL("../node_modules/.cache/next-sse/topology-start.lock", import.meta.url),
);

/** The pid the turn names right now, or nothing when nobody holds it. */
async function heldBy(lock: string): Promise<number | undefined> {
  try {
    return Number(await readFile(lock, "utf8")) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether that process is still running. `kill(pid, 0)` sends nothing and only asks; a process
 * this one may not signal is somebody else's and very much alive.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When that file was last written, or nothing when it is not there any more. */
async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Whether the turn has been held so long that no live start could still explain it. */
async function abandoned(lock: string): Promise<boolean> {
  const held = await mtimeOf(lock);

  return held !== undefined && Date.now() - held > ABANDONED_AFTER_MS;
}

/**
 * Write a pid to a path nothing occupies, and say whether it got there: creating the file
 * exclusively is one operation, so of several processes doing this at once exactly one comes
 * back holding it. The pid is a parameter because a turn is also written back on behalf of the
 * holder it was taken from (see `clear`).
 */
async function claim(path: string, pid: number = process.pid): Promise<boolean> {
  try {
    const file = await open(path, "wx");
    try {
      await file.writeFile(String(pid));
    } finally {
      await file.close();
    }

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;

    throw error;
  }
}

/** Whether the turn is nobody's: its holder's process is gone, or it is older than any start. */
async function stale(lock: string): Promise<boolean> {
  const holder = await heldBy(lock);

  return holder === undefined || !alive(holder) || (await abandoned(lock));
}

/**
 * Clear a turn nobody holds — a worker killed mid-start leaves one behind, and it must not stop
 * the run for ever.
 *
 * Renaming it away is what makes that safe, and nothing else here would: of several waiters
 * that all found the same turn stale, exactly one rename succeeds and the rest get `ENOENT` and
 * go back to waiting. Removing the file instead would let the second waiter remove what the
 * first had already handed to a live starter, and two starters would then believe they hold the
 * same turn (found in review).
 *
 * What was renamed away is then judged on its own, because between finding the turn stale and
 * taking it away it may have become somebody's: a rename carries the file's pid and its age
 * along, so a turn that turns out to be held is written straight back to where it was.
 *
 * The name renamed to is this clearing's own, so that two of them can never be the same file;
 * one left behind by a process that died mid-clear is read by nobody, and goes with the folder.
 */
async function clear(lock: string): Promise<void> {
  const taken = `${lock}.stale-${randomUUID()}`;

  try {
    await rename(lock, taken);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    return;
  }

  const holder = await heldBy(taken);
  if (holder !== undefined && !(await stale(taken))) await claim(lock, holder);
  await rm(taken, { force: true });
}

/**
 * Take the turn, waiting for whoever has it, and clearing it when it is nobody's.
 *
 * The file is read back after it is created, and that is the last line rather than the first:
 * a turn taken away in the instant it was granted is written back by whoever took it, unless
 * a third starter claimed the free path in between — and a starter that does not find its own
 * pid in the file it just wrote waits like the others rather than start beside someone.
 */
async function take(lock: string): Promise<void> {
  await mkdir(dirname(lock), { recursive: true });

  for (;;) {
    if ((await claim(lock)) && (await heldBy(lock)) === process.pid) return;
    if (await stale(lock)) await clear(lock);

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Give the turn back, and only ever this process's own. */
async function give(lock: string): Promise<void> {
  if ((await heldBy(lock)) === process.pid) await rm(lock, { force: true });
}

/**
 * Start something that binds **fixed host ports** — a whole topology, ports reserved and
 * container brought up — one starter at a time across every worker of the run, and again from
 * the top when Docker says the port was already allocated.
 *
 * Both halves answer the same thing, from opposite ends. A topology reserves free ports and
 * only then asks Docker to bind them, so between the two any other worker can take one; and
 * five topology files starting at once also put five containers through Docker's port
 * publishing at once, which is where testcontainers' ten-second wait for the ports to be bound
 * to the host runs out. Held across the *whole* start — the container is up and its ports are
 * bound when the turn is given back — the turn removes the collision and the pile-up together.
 *
 * The retry is the remainder: the run's other port takers — the standalone container Docker
 * maps itself, the proxies a case puts in front of a node — take no turn, so a collision is
 * unlikely rather than impossible. It is keyed on Docker's own words and on nothing else: any
 * other failure to start is this project's to see, immediately, and the last thing Docker said
 * is what is thrown when the attempts run out.
 *
 * `start` is re-run whole, which is the point: the ports it reserved are reserved again, so an
 * attempt never asks for the number it just lost.
 */
export async function takingHostPorts<T>(
  start: () => Promise<T>,
  lock: string = LOCK_FILE,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      await take(lock);
      try {
        return await start();
      } finally {
        await give(lock);
      }
    } catch (error) {
      if (attempt >= START_ATTEMPTS || !String(error).includes(PORT_TAKEN)) throw error;
    }
  }
}
