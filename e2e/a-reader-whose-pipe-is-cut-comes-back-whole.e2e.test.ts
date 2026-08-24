import { expect, test } from "vitest";

import {
  openBrowser,
  readerIn,
  rowsOf,
  waitForRow,
  waitForText,
  waitUntilLive,
  RECONNECT_WAIT_MS,
} from "./harness/browser.js";
import { publish } from "./harness/demo.js";
import { assertPromptExit, startInstance } from "./harness/example.js";
import { startProxy } from "./harness/proxy.js";

/** What was Published while the reader could not be reached, in the order the log took it. */
const WHILE_AWAY = ["the first one missed", "the second one missed", "the third one missed"];

/**
 * The commute, in a browser: a reader loses the network mid-Connection, the App goes on
 * Publishing without them, and when the network comes back the page holds every Message that
 * was sent — each of them once, in order, with no reload and nothing refetched.
 *
 * The wire half of this is somebody else's claim: a Cursor resumes a Connection and the Instance
 * cuts the replay exactly where the live feed takes over (ADR-0005), and the headless scenarios
 * hold it to that on the protocol. What only a browser proves is the other half — that the DOM
 * ends up right. Between the wire and the list on screen sit the browser's own `EventSource`
 * reconnect, the core's Cursor, and `upsertBy('id')` merging a replay into state a component
 * already holds; a library that delivers exactly once and a page that shows a Message twice are
 * the same bug to the person reading it.
 *
 * The cut is made at the network, by destroying the sockets the address in front of the Instance
 * is holding: the pipe under this page dies mid-block, with nothing sent to say so — no `reconnect`
 * from the Instance, no end of body, no answer at all. `BrowserContext.setOffline` is not that
 * and was tried first: Chromium's offline emulation refuses *new* requests and leaves an
 * established `text/event-stream` hanging, so the page would sit there until the heartbeat
 * watchdog fired three beats later — a real case, and a different one from this. What recovers
 * the reader below is the browser's own `EventSource` retry, driven by nothing in this test.
 *
 * Nothing here touches the App or the Instance: the Publishes go on from the outside, exactly as
 * they would have.
 */
test("a reader whose pipe is cut comes back with every Message, once", async () => {
  const instance = await startInstance();
  const proxy = await startProxy(instance.url);
  const browser = await openBrowser();
  const reader = await readerIn(browser);
  const { page } = reader;

  try {
    await reader.open(proxy.url);
    await waitUntilLive(page);

    await publish(instance.url, "before the network went");
    await waitForRow(page, "messages", "before the network went");

    /**
     * The pipe cut, and the page knows it: the status is the client core's own reading of a
     * Connection that has gone, and waiting for it is what makes the Publishes below land in the
     * gap rather than on a Connection that is somehow still up.
     */
    proxy.cut();
    await waitForText(page, "status", "reconnecting", RECONNECT_WAIT_MS);

    for (const text of WHILE_AWAY) await publish(instance.url, text);

    await waitUntilLive(page, RECONNECT_WAIT_MS);

    /**
     * One more Publish, after the stream is live again, and the assertion waits for *that* one:
     * anything the replay was going to deliver twice has been delivered by the time a Message
     * published after it arrives. Asserting on the last missed Message instead would read the
     * list at the very moment a duplicate might still be in flight.
     */
    await publish(instance.url, "and the reader is back");
    await waitForRow(page, "messages", "and the reader is back");

    expect(await rowsOf(page, "messages")).toEqual([
      "before the network went",
      ...WHILE_AWAY,
      "and the reader is back",
    ]);
  } finally {
    await reader.close();
    await browser.close();
    await proxy.close();
    assertPromptExit(await instance.stop());
  }
});
