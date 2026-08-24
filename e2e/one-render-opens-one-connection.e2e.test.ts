import { expect, test } from "vitest";

import { openBrowser, readerIn, waitForRow, waitUntilLive } from "./harness/browser.js";
import { publish } from "./harness/demo.js";
import { assertPromptExit, startInstance } from "./harness/example.js";

/**
 * Every Channel the demo page subscribes to, which is four server components handing four
 * Snapshots to four hooks — and, if the claim holds, one Connection between them.
 */
const DEMO_CHANNELS = ["chat:42", "announcements", "notifications:anonymous", "admin"];

/**
 * One render, one Connection, one Cursor — the claim that only a browser can be asked about.
 *
 * The demo page mints a Snapshot in four different server components, and every one of them
 * takes a Cursor before its read. They share one because `sse.snapshot` reads the log's position
 * through `React.cache`: within one render, the first call takes it and the rest are handed the
 * same one. Nothing outside an RSC render can exercise that — a unit test has no render, and the
 * client project has no server — so this is the only place it is proven at all (#35, ruling 9).
 *
 * What a browser can see of it is this: after hydration the page has opened exactly one
 * `/api/sse` request, carrying all four Channels and one `cursor`. The count is read off the
 * requests the browser made, never out of the RSC payload, which is Next's business and not a
 * place to read a Cursor from (ADR-0009).
 *
 * The limit of the claim, said out loud: one request is the observable *shadow* of the shared
 * Cursor, not the Cursor itself. Four Snapshots holding four different Cursors would also be
 * coalesced onto one Connection by the client core, which spends whichever it was handed last
 * — the core cannot compare two Cursors and must not learn how (ADR-0001). What this scenario
 * therefore rules out is the failure that matters and that a page pays for: a Connection per
 * Snapshot, four streams where a reader should hold one.
 */
test("a page of several Snapshots opens one Connection carrying every Channel", async () => {
  const instance = await startInstance();
  const browser = await openBrowser();
  const reader = await readerIn(browser);
  const { page } = reader;

  try {
    await reader.open(instance.url);
    await waitUntilLive(page);

    /**
     * A round trip through the live stream before the count is read: it puts the page well past
     * the tick the core coalesces subscriptions on, so a second Connection — one opened by a
     * hook that did not join the first — would already be on the record.
     */
    await publish(instance.url, "one Connection carries this");
    await waitForRow(page, "messages", "one Connection carries this");

    expect(reader.connections).toHaveLength(1);
    const [connection] = reader.connections;
    expect(connection?.searchParams.getAll("channel")).toEqual(DEMO_CHANNELS);
    expect(connection?.searchParams.getAll("cursor")).toEqual([expect.any(String)]);
  } finally {
    await reader.close();
    await browser.close();
    assertPromptExit(await instance.stop());
  }
});
