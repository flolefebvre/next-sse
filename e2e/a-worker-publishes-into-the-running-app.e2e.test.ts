import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { openBroadcastStream } from "./harness/demo.js";
import { anApp, assertPromptExit, EXAMPLE_DIR, startInstance } from "./harness/example.js";
import type { Stream } from "./harness/stream.js";

const run = promisify(execFile);

/** The two publishers the example ships, as a reader of it would run them. */
const WORKERS = {
  typed: `${EXAMPLE_DIR}worker/publish.ts`,
  raw: `${EXAMPLE_DIR}worker/raw-envelope.ts`,
};

/** What either worker prints about the Publish it just made, as one line of JSON. */
interface Published {
  published: string;
  cursor: string;
}

/**
 * Run one of the example's workers against the App's log, in a process of its own — which is
 * the point of the pattern: neither of them is a request, and neither runs inside the App.
 */
async function publishFrom(worker: string, env: Record<string, string>, text: string) {
  const { stdout } = await run(process.execPath, ["--import", "tsx", worker, text], {
    env: { ...process.env, ...env },
  });

  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Published;
}

/** The next broadcast off a Connection: the Channel it came on, and what a reader would see. */
async function nextAnnouncement(stream: Stream) {
  const received = await stream.next("message");
  const { channel, event, payload } = JSON.parse(received.data) as {
    channel: string;
    event: string;
    payload: { text: string };
  };

  return { channel, event, text: payload.text, cursor: received.lastEventId };
}

/**
 * Publishing from outside Next.js, into an App that is running: the example's own two workers,
 * against a real Instance of the built example app, reaching a Connection that Instance holds.
 *
 * They are the two ends of the same pattern. `worker/publish.ts` holds the App's Registry as a
 * type over a Publisher, so its Channel names, events and payloads are checked and it still
 * loads no Next.js; `worker/raw-envelope.ts` has the library nowhere in sight and writes the
 * `{ v: 1, … }` envelope of ADR-0006 straight to the log, which is what a service in another
 * language does. The Instance cannot tell them apart, and neither can the Connection: that is
 * the promise the wire format makes, and this is where it is kept.
 */
test("a worker outside Next.js and a raw envelope both reach a Connection", async () => {
  const app = anApp();
  const instance = await startInstance(app);
  const stream = openBroadcastStream(instance.url);

  try {
    await stream.next("ready");
    await stream.next("caught-up");

    const typed = await publishFrom(WORKERS.typed, app.env, "the worker shipped it");
    const fromWorker = await nextAnnouncement(stream);
    expect(fromWorker).toEqual({
      channel: "announcements",
      event: "posted",
      text: "the worker shipped it",
      cursor: typed.cursor,
    });

    const raw = await publishFrom(WORKERS.raw, app.env, "written straight to the log");
    const fromRaw = await nextAnnouncement(stream);
    expect(fromRaw).toEqual({
      channel: "announcements",
      event: "posted",
      text: "written straight to the log",
      cursor: raw.cursor,
    });
  } finally {
    stream.close();
    assertPromptExit(await instance.stop());
  }
});
