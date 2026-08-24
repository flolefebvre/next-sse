import { expect, test } from "vitest";

import {
  openBrowser,
  aLiveReaderOn,
  rowsOf,
  waitForRow,
  waitUntilLive,
  RECONNECT_WAIT_MS,
} from "./harness/browser.js";
import { publish } from "./harness/demo.js";
import { anApp, assertPromptExit, startInstance, twoInstances } from "./harness/example.js";
import { startProxy } from "./harness/proxy.js";

/** Long enough for two `next start` boots, a browser, and a Connection that has to come back. */
const PATIENCE_MS = 180_000;

/**
 * The rolling deploy, seen from the page: a reader has the App open, the Instance behind the
 * address their browser knows is taken out from under them, and the list on screen ends up
 * holding every Message — the ones from before the deploy, the one Published while they were
 * between two Connections, and the ones after — each of them once, with no reload.
 *
 * The headless scenario next door makes this claim on the wire, and it is the same claim; what
 * is added here is everything between the wire and the reader. React state seeded by a server
 * render on an Instance that no longer exists, a replay merged into it by `upsertBy('id')`, a
 * browser reconnecting on its own — none of that is exercised by an `EventSource` in Node.
 *
 * The address is a throwaway load balancer, because that is what a deploy moves and the only
 * way failover means anything: a client pointed straight at a process that dies has nowhere to
 * come back to (ADR-0009). The second scenario in this file is the other shape of the same
 * accident — the process comes back at the address it died on — and it is the secondary one on
 * purpose: it proves recovery, but never that a client can be moved.
 */
test(
  "a reader whose Instance is taken out sees the whole room on the survivor",
  { timeout: PATIENCE_MS },
  async () => {
    const app = await twoInstances();
    const proxy = await startProxy(app.here.url);
    const browser = await openBrowser();

    try {
      const { page } = await aLiveReaderOn(browser, proxy.url);

      await publish(app.here.url, "before the deploy");
      await waitForRow(page, "messages", "before the deploy");

      /** The deploy, in the order an orchestrator does it: the address moves, then the signal. */
      proxy.sendTo(app.there.url);
      const stopping = app.here.stop();

      /**
       * Published on the survivor while the reader is between two Connections — the window the
       * Cursor exists for. It goes out before the exit is awaited, because the window is the
       * client's `retry:` and not however long a process takes to go: waiting first would risk
       * the reader already being back, and this Message arriving live rather than replayed.
       */
      await publish(app.there.url, "while it was away");
      assertPromptExit(await stopping);

      await waitForRow(page, "messages", "while it was away", RECONNECT_WAIT_MS);
      await waitUntilLive(page, RECONNECT_WAIT_MS);

      await publish(app.there.url, "and the deploy is over");
      await waitForRow(page, "messages", "and the deploy is over");
      expect(await rowsOf(page, "messages")).toEqual([
        "before the deploy",
        "while it was away",
        "and the deploy is over",
      ]);
    } finally {
      await app.stop();
      await proxy.close();
      await browser.close();
    }
  },
);

/**
 * The same accident without a load balancer, and without a warning: the process the reader is
 * talking to is killed where it stands, and another one takes its place at the same address — a
 * crash loop, a `docker compose up` on one host.
 *
 * It is a `SIGKILL` and not the deploy's signal, which is what makes it the other half of the
 * pair: above, the Instance ends its Connections itself and the client is told to reconnect
 * (ADR-0011); here it is simply gone, the socket dies mid-block, and nothing is said at all. The
 * recovery has to be the client's own either way.
 *
 * It is the secondary form (ADR-0009) and it is here for what it does prove: the App's state is
 * in the log and not in the process, so a Connection resumed on a Cursor minted by a process
 * that no longer exists is replayed exactly what it missed by the one that replaced it. What it
 * cannot prove is failover — the reader never moves, and an address that comes back is not a
 * client following its App somewhere else.
 *
 * The Publishing is done by a second Instance the reader never talks to, because a gap needs
 * something to happen inside it: with the reader's own Instance down, an App of one Instance
 * has nobody to Publish through, and the scenario would only ever show a Message that arrived
 * live after the recovery.
 */
test(
  "a reader whose Instance is restarted on the same port is replayed what it missed",
  { timeout: PATIENCE_MS },
  async () => {
    const app = anApp();
    const publisher = await startInstance(app);
    let instance = await startInstance(app);
    const browser = await openBrowser();

    try {
      const { page } = await aLiveReaderOn(browser, instance.url);

      await publish(publisher.url, "before the restart");
      await waitForRow(page, "messages", "before the restart");

      await instance.kill();
      await publish(publisher.url, "while it was down");

      /** The replacement, at the address the reader is already retrying against. */
      instance = await startInstance(app, {}, instance.port);

      await waitForRow(page, "messages", "while it was down", RECONNECT_WAIT_MS);
      await waitUntilLive(page, RECONNECT_WAIT_MS);

      await publish(publisher.url, "and it is back");
      await waitForRow(page, "messages", "and it is back");
      expect(await rowsOf(page, "messages")).toEqual([
        "before the restart",
        "while it was down",
        "and it is back",
      ]);
    } finally {
      /**
       * The reader is still on the page and their browser is still holding its Connection to
       * this Instance, with nothing in between — the shape a signalled Instance used to sit out
       * its whole grace window on, because the client reconnected over the pooled keep-alive
       * socket faster than the server could reap it (#74). The refusal closes that socket now,
       * and `assertPromptExit` is where this scenario says so.
       */
      assertPromptExit(await instance.stop());
      assertPromptExit(await publisher.stop());
      await browser.close();
    }
  },
);
