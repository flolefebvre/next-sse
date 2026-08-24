import { expect, test } from "vitest";

import {
  openBrowser,
  readerIn,
  rowsOf,
  textOf,
  waitForRow,
  waitForText,
  waitUntilLive,
  RECONNECT_WAIT_MS,
} from "./harness/browser.js";
import { publish } from "./harness/demo.js";
import { assertPromptExit, startInstance } from "./harness/example.js";

/**
 * Authorization lost while the page is open, in the browser: the reader changes what they are
 * allowed to be, is Kicked, and the admin panel goes from live to `refused` on the spot — no
 * reload, no navigation — while the room next to it goes on streaming across the same cut.
 *
 * It is the one path through the example nothing else executes. The headless scenarios drive
 * `POST /api/kick` and prove refusal-on-reconnect on the wire; the handler tests prove the
 * decision. What has never run is the click: `switchRole` then `kickMe`, two calls in that
 * order, from a page that stays where it is. That order is the whole lesson of `kickMe` — a Kick
 * issued by the very request that changed the session races that request's own response — and
 * this is the only place it is observable, because the thing it decides is which session the
 * *next* Connection is Authorized against.
 *
 * Both directions are here, and only one of them is the claim. A reader arrives as a guest, so
 * becoming an admin is how this scenario gets an admin at all — the demo's own button, rather
 * than a cookie planted from the outside, since a session this test forged would prove nothing
 * about the App that issues one. Then comes the half that matters: the role is given back, and
 * the Channel that was live is refused on the Connection that replaces it.
 */
test("a reader who loses the role sees that Channel refused while the room streams on", async () => {
  const instance = await startInstance();
  const browser = await openBrowser();
  const reader = await readerIn(browser);
  const { page } = reader;

  try {
    await reader.open(instance.url);
    await waitUntilLive(page);

    /** A guest, on the Connection the server rendered for one: the room, and no notices. */
    expect(await textOf(page, "role")).toBe("guest");
    expect(await textOf(page, "notices-status")).toBe("refused");

    await publish(instance.url, "before the role changed");
    await waitForRow(page, "messages", "before the role changed");

    /**
     * The role granted, which is a Kick and a reconnect and nothing else: the page is not
     * reloaded, the room's Connection is the one that carries the newly allowed Channel, and
     * Authorize is asked again on the way in. A Channel refused a moment ago is asked for again
     * on the next connect (ADR-0003), which is the only way one is ever given back.
     */
    await page.getByRole("button", { name: "Become an admin" }).click();
    await waitForText(page, "role", "admin");
    await waitForText(page, "notices-status", "live", RECONNECT_WAIT_MS);

    await publish(instance.url, "while an admin was reading");
    await waitForRow(page, "messages", "while an admin was reading");

    /**
     * And the role taken away again — the claim of this scenario. `refused` is the status of
     * this subscriber alone (ADR-0003): the Connection carrying it is live and well, and the
     * room hanging off the same wire is told nothing about somebody else's refusal.
     */
    await page.getByRole("button", { name: "Become a guest" }).click();
    await waitForText(page, "role", "guest");
    await waitForText(page, "notices-status", "refused", RECONNECT_WAIT_MS);

    /**
     * The room, after both cuts: still live, and still the same list. The Message Published
     * after the flip proves the stream is carrying, and the one Published before it proves the
     * two reconnects replayed nothing twice — `upsertBy('id')` absorbs an echo, and a row that
     * appeared twice would be a Message the log handed out under two positions.
     */
    await publish(instance.url, "after the role changed");
    await waitForRow(page, "messages", "after the role changed");
    await waitUntilLive(page);
    expect(await rowsOf(page, "messages")).toEqual([
      "before the role changed",
      "while an admin was reading",
      "after the role changed",
    ]);
  } finally {
    await reader.close();
    await browser.close();
    assertPromptExit(await instance.stop());
  }
});
