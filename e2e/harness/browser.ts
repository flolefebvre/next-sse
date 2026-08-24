import { chromium, type Browser, type Page } from "playwright";

/**
 * The demo page in a real browser: what a browser scenario needs of Chromium, and what it needs
 * of the page it opens there.
 *
 * It sits beside `demo.ts` rather than inside it so that the headless scenarios — every one of
 * them — keep an import graph with no browser in it. What a scenario drives from the server side
 * is still `demo.ts`'s business: a webhook Publish and a Kick are things that happen elsewhere,
 * and only what a reader does with their own hands belongs here.
 *
 * Playwright is used as a library, inside this Vitest project, Chromium alone (ADR-0009). There
 * is no second runner and no auto-retrying `expect`: the waits below are the browser's own, and
 * what a scenario asserts on is the value they settled at.
 */

/** How long a scenario waits for the page to catch up before calling it a failure. */
const WAIT_MS = 20_000;
/** Long enough for a Connection to come back through the `retry:` the Instance sent (ADR-0004). */
export const RECONNECT_WAIT_MS = 30_000;

/**
 * One Chromium for the scenario that opens it, and every scenario owes it a `close()` in a
 * `finally` — a browser left running holds a process and a temporary profile for the rest of the
 * machine's day, exactly as a `next start` does.
 *
 * It is launched per scenario file rather than once for the run because the e2e project forks a
 * process per file (ADR-0009): there is no place a shared browser could live.
 */
export function openBrowser(): Promise<Browser> {
  return chromium.launch();
}

/** One reader of the demo page, holding the Connection their browser holds. */
export interface Reader {
  /** The page itself, for the scenarios that intercept its requests or drive its forms. */
  page: Page;
  /**
   * The `/api/sse` requests this browser has made, in the order it made them: one per Connection
   * it opened, with the Channels and the Cursor it asked for on the query.
   */
  connections: URL[];
  /** Open the demo page. What happens next is the scenario's to wait for. */
  open(url: string): Promise<void>;
  /** The network dropping under this reader, and coming back. */
  offline(dropped: boolean): Promise<void>;
  close(): Promise<void>;
}

/**
 * A reader in a browser context of their own: their own cookie jar, their own network. Two
 * readers of one scenario are two contexts, never two pages of one, so the role cookie of one
 * and the offline emulation of the other stay theirs.
 */
export async function readerIn(browser: Browser): Promise<Reader> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const connections: URL[] = [];

  /**
   * Recorded on the context rather than counted after the fact: a Connection the core opened and
   * dropped inside a second is still a request this browser made, and a scenario about how many
   * there were has to see it.
   */
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/sse") connections.push(url);
  });

  return {
    page,
    connections,
    open: async (url: string) => {
      await page.goto(url);
    },
    offline: (dropped: boolean) => context.setOffline(dropped),
    close: () => context.close(),
  };
}

/**
 * Wait until that panel holds exactly this — a status, which is one element and one word.
 *
 * The wait runs in the page, so it settles on the very first render that says so rather than on
 * the next poll from here: a `refused` that lasted one Connection is a thing this has to catch.
 */
export function waitForText(page: Page, testid: string, text: string, timeoutMs = WAIT_MS) {
  return page.waitForFunction(
    ([id, want]) => document.querySelector(`[data-testid="${id}"]`)?.textContent === want,
    [testid, text],
    { timeout: timeoutMs },
  );
}

/** Wait until that list shows a row saying exactly this. */
export function waitForRow(page: Page, testid: string, text: string, timeoutMs = WAIT_MS) {
  return page.waitForFunction(
    ([id, want]) =>
      [...document.querySelectorAll(`[data-testid="${id}"] li`)].some(
        (row) => row.textContent === want,
      ),
    [testid, text],
    { timeout: timeoutMs },
  );
}

/**
 * Every row of that list, in the order the page shows them — which is what a scenario about
 * loss and duplication reads: the count is as much of the claim as the contents.
 */
export function rowsOf(page: Page, testid: string): Promise<string[]> {
  return page.getByTestId(testid).locator("li").allTextContents();
}

/** What that panel says right now: a status, or anything else the page holds in one element. */
export async function textOf(page: Page, testid: string): Promise<string> {
  return (await page.getByTestId(testid).textContent()) ?? "";
}

/**
 * The room's Connection is live: the server render is on screen, hydration has run, and the
 * stream has caught up with it. Every scenario starts here, because everything they are about
 * happens after the handoff — except the one that is about the handoff itself.
 */
export function waitUntilLive(page: Page, timeoutMs = WAIT_MS) {
  return waitForText(page, "status", "live", timeoutMs);
}
