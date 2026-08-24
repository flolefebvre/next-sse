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

/**
 * How long a starter waits for its turn before starting without one.
 *
 * Waiting has to be bounded, and by less than the caller's own budget: a `beforeAll` that times
 * out does not cancel the start it is waiting on, so a turn is held until the start under it
 * settles whatever the file that asked for it does. Without a bound, one start that is merely
 * slow would spend every waiting file's budget as well as its own, and one late topology would
 * fail five (found by measuring: the coarse first version of this did exactly that).
 *
 * Above what several ordinary starts take, well under the 180 s a file gives its topology, and
 * what it degrades into is the behaviour this file was written to improve rather than a new
 * failure: starters that stopped waiting bind their ports at the same time again, and Docker's
 * refusal is what the retry is for.
 */
export const TURN_WAIT_MS = 90_000;

/**
 * What a start is taken from the top for, and nothing else. Both are Docker's own words about
 * the host ports, and both are the same accident — the ports this run picked are not this run's
 * to bind by the time it asks. The first is the refusal; the second is testcontainers giving up
 * on the publishing it asked for, on a bound of ten seconds it hardcodes and takes no argument
 * for. Any other failure to start is this project's to see, immediately.
 */
const RETRIED_ON = [
  "port is already allocated",
  "waiting for container ports to be bound to the host",
];

/** The label a topology's container carries, so that the one an attempt left can be found. */
export const TOPOLOGY_LABEL = "next-sse.topology";

/** What removing that container needs of Docker: what carries a label, and its removal. */
export interface Containers {
  labelled(label: string): Promise<string[]>;
  remove(id: string): Promise<void>;
}

/** Where the turn is taken, and what a start that failed under it leaves behind. */
export interface StartTurn {
  /** Docker, as removing what a failed attempt left needs it. */
  containers: Containers;
  /** The file the turn is written in. The run's own unless a test says otherwise. */
  lock?: string;
  /** How long to wait for the turn before starting without it. */
  waitMs?: number;
}

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
 * Take the turn, waiting for whoever has it, clearing it when it is nobody's — and answering
 * whether it was granted at all, because the wait is bounded and a starter that ran out of it
 * goes ahead regardless.
 *
 * The file is read back after it is created, and that is the last line rather than the first:
 * a turn taken away in the instant it was granted is written back by whoever took it, unless
 * a third starter claimed the free path in between — and a starter that does not find its own
 * pid in the file it just wrote waits like the others rather than start beside someone.
 */
async function take(lock: string, waitMs: number): Promise<boolean> {
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + waitMs;

  for (;;) {
    if ((await claim(lock)) && (await heldBy(lock)) === process.pid) return true;
    if (await stale(lock)) await clear(lock);
    if (Date.now() >= deadline) return false;

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Give the turn back, and only ever this process's own. */
async function give(lock: string): Promise<void> {
  if ((await heldBy(lock)) === process.pid) await rm(lock, { force: true });
}

/**
 * Start something that binds **fixed host ports** — ports reserved and a container brought up
 * on them — one starter at a time across every worker of the run, and again from the top when
 * Docker says the port was already allocated.
 *
 * Both halves answer the same thing, from opposite ends. A topology reserves free ports and
 * only then asks Docker to bind them, so between the two any other worker can take one; and
 * five topology files starting at once also put five containers through Docker's port
 * publishing at once, which is where testcontainers' ten-second wait for the ports to be bound
 * to the host runs out. The turn covers exactly that stretch — from picking the numbers to
 * Docker having them bound — and its caller gives it back before waiting for whatever is inside
 * the container to settle, which is the slow part and no business of anyone else's ports.
 *
 * The retry is the remainder: the run's other port takers — the standalone container Docker
 * maps itself, the proxies a case puts in front of a node — take no turn, so a collision is
 * unlikely rather than impossible, and the ten seconds testcontainers gives Docker to publish
 * the ports can run out on a busy machine with nobody to blame at all. What it is keyed on is
 * `RETRIED_ON` and nothing looser, and the last thing Docker said is what is thrown when the
 * attempts run out.
 *
 * `start` is re-run whole, which is the point: the ports it reserved are reserved again, so an
 * attempt never asks for the number it just lost. It is handed the label its container must
 * carry, because an attempt that failed can have left one running on the ports it lost — Docker
 * refuses the binding before the container starts, but a publishing that timed out has it up —
 * and nothing else would ever take it down: the caller never got a handle on it, and Ryuk only
 * sweeps when the run ends. So every attempt that fails, retried or not, is swept here first.
 */
export async function takingHostPorts<T>(
  start: (label: string) => Promise<T>,
  turn: StartTurn,
): Promise<T> {
  const { containers, lock = LOCK_FILE, waitMs = TURN_WAIT_MS } = turn;

  for (let attempt = 1; ; attempt++) {
    const label = randomUUID();

    try {
      const took = await take(lock, waitMs);
      try {
        return await start(label);
      } finally {
        if (took) await give(lock);
      }
    } catch (error) {
      for (const id of await containers.labelled(label)) await containers.remove(id);
      if (attempt >= START_ATTEMPTS || !RETRIED_ON.some((said) => String(error).includes(said))) {
        throw error;
      }
    }
  }
}
