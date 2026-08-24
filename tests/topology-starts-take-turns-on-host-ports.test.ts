import { spawn } from "node:child_process";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, expect, test } from "vitest";

import { ABANDONED_AFTER_MS, START_ATTEMPTS, takingHostPorts } from "./topology-start.js";

/** The Docker daemon's words when the host port a container asks for is taken by someone else. */
const PORT_TAKEN =
  "driver failed programming external connectivity on endpoint quirky_shaw " +
  "(0e5d0d): Bind for 0.0.0.0:51731 failed: port is already allocated";

let lock: string;

beforeEach(async () => {
  lock = join(await mkdtemp(join(tmpdir(), "next-sse-lock-")), "topology-start.lock");
});

/** A pid that is certainly not running: one this process started and then buried. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));

  return child.pid ?? 0;
}

test("only one caller at a time is inside the start", async () => {
  let inside = 0;
  let most = 0;

  await Promise.all(
    Array.from({ length: 6 }, async (_, index) =>
      takingHostPorts(async () => {
        inside += 1;
        most = Math.max(most, inside);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inside -= 1;

        return index;
      }, lock),
    ),
  );

  expect(most).toBe(1);
  expect(inside).toBe(0);
});

test("a start that throws still hands the turn on", async () => {
  await expect(
    takingHostPorts(() => Promise.reject(new Error("no container for you")), lock),
  ).rejects.toThrow("no container for you");

  await expect(takingHostPorts(() => Promise.resolve("in"), lock)).resolves.toBe("in");
});

test("a turn left behind by a process that died is taken over", async () => {
  await writeFile(lock, String(await deadPid()));

  await expect(takingHostPorts(() => Promise.resolve("in"), lock)).resolves.toBe("in");
});

test("several starters facing a turn nobody holds still go in one at a time", async () => {
  await writeFile(lock, String(await deadPid()));

  let inside = 0;
  let most = 0;

  await Promise.all(
    Array.from({ length: 6 }, async () =>
      takingHostPorts(async () => {
        inside += 1;
        most = Math.max(most, inside);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inside -= 1;
      }, lock),
    ),
  );

  expect(most).toBe(1);
});

test("a turn held far longer than any start could last is taken over", async () => {
  await writeFile(lock, String(process.pid));
  const longAgo = new Date(Date.now() - ABANDONED_AFTER_MS - 60_000);
  await utimes(lock, longAgo, longAgo);

  await expect(takingHostPorts(() => Promise.resolve("in"), lock)).resolves.toBe("in");
});

test("the turn is held for as long as the start runs, and given back after it", async () => {
  const held = await takingHostPorts(() => readFile(lock, "utf8"), lock);

  expect(held).toBe(String(process.pid));
  await expect(readFile(lock, "utf8")).rejects.toThrow("ENOENT");
});

test("a turn another live process holds is waited for, not taken", async () => {
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 30000)"], {
    stdio: "ignore",
  });
  await writeFile(lock, String(holder.pid));

  let started = false;
  const waiting = takingHostPorts(() => {
    started = true;

    return Promise.resolve("in");
  }, lock);

  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(started).toBe(false);

  holder.kill();
  await new Promise((resolve) => holder.on("exit", resolve));

  await expect(waiting).resolves.toBe("in");
});

test("a starter done waiting goes ahead, and gives away no turn it never took", async () => {
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 30000)"], {
    stdio: "ignore",
  });
  await writeFile(lock, String(holder.pid));

  await expect(takingHostPorts(() => Promise.resolve("in"), lock, 300)).resolves.toBe("in");
  await expect(readFile(lock, "utf8")).resolves.toBe(String(holder.pid));

  holder.kill();
  await new Promise((resolve) => holder.on("exit", resolve));
});

test("a start Docker refused the host port to is run again, from scratch", async () => {
  let attempts = 0;

  const started = await takingHostPorts(() => {
    attempts += 1;
    if (attempts === 1) throw new Error(PORT_TAKEN);

    return Promise.resolve("started");
  }, lock);

  expect(started).toBe("started");
  expect(attempts).toBe(2);
});

test("a start that failed for any other reason is not run again", async () => {
  let attempts = 0;

  await expect(
    takingHostPorts(() => {
      attempts += 1;

      throw new Error("no such image");
    }, lock),
  ).rejects.toThrow("no such image");
  expect(attempts).toBe(1);
});

test("the retries are bounded, and what Docker last said is what is thrown", async () => {
  let attempts = 0;

  await expect(
    takingHostPorts(() => {
      attempts += 1;

      throw new Error(`${PORT_TAKEN} (attempt ${String(attempts)})`);
    }, lock),
  ).rejects.toThrow(`(attempt ${String(START_ATTEMPTS)})`);
  expect(attempts).toBe(START_ATTEMPTS);
});
