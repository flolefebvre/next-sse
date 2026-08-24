import { expect, test } from "vitest";

import {
  openBrowser,
  readerIn,
  rowsOf,
  waitForRow,
  waitUntilLive,
  type Reader,
} from "./harness/browser.js";
import { publish } from "./harness/demo.js";
import { assertPromptExit, startInstance } from "./harness/example.js";

/** What the server rendered into the page, and what was Published while nobody was listening. */
const RENDERED = "rendered into the page";
const IN_THE_WINDOW = "published inside the handoff window";

/**
 * The handoff window, held open on purpose, in a real browser: the hard requirement of this
 * library, and the one claim no headless scenario can make.
 *
 * Between the read a server component took and the moment that page's stream goes live, there is
 * a window — hydration, a bundle to fetch, a Connection to open — and anything Published inside
 * it belongs to neither side: too late for the HTML, too early for the stream. `sse.snapshot`
 * exists to close it, by taking the Cursor *before* the read so the Connection resumes from
 * there and is replayed what it missed.
 *
 * The window is normally milliseconds wide and nothing could be Published into it reliably, so
 * this scenario holds it open: the Connection the hydrated page opens is intercepted and stalled
 * (ADR-0009), a Message is Published while it hangs, and only then is it let through. What comes
 * back has to hold the replay and the render together — the Message that was already on the page
 * still shown once, the one from the window shown once, in order.
 *
 * Everything here is real: Next.js served the HTML, React hydrated it, and the browser's own
 * `EventSource` opened the stream. That is the whole reason Playwright is in this project.
 */
test("a Publish inside the handoff window reaches the hydrated page exactly once", async () => {
  const instance = await startInstance();
  const browser = await openBrowser();
  const reader = await readerIn(browser);
  const { page } = reader;

  try {
    /** On the page before it is asked for, so the server render has something to hand down. */
    await publish(instance.url, RENDERED);

    const window = await holdTheConnection(reader);
    await reader.open(instance.url);

    /**
     * The page is hydrated and its Connection is on the wire, going nowhere: whatever is on
     * screen now is the server render alone, and this is the window.
     */
    await window.opened;
    expect(await rowsOf(page, "messages")).toEqual([RENDERED]);

    await publish(instance.url, IN_THE_WINDOW);
    window.release();

    /**
     * The stream goes live, and the page has both — the Snapshot's own Message once, though the
     * replay carried it again, and the one from the window once, though nothing on the page had
     * ever seen it. Order is the log's: this is a replay, not a merge of two opinions.
     */
    await waitForRow(page, "messages", IN_THE_WINDOW);
    await waitUntilLive(page);
    expect(await rowsOf(page, "messages")).toEqual([RENDERED, IN_THE_WINDOW]);

    /**
     * And the reason it worked, on the request itself: the Connection this page opened asked to
     * resume from a position it was given, rather than joining the log wherever it stood. That
     * position is the Snapshot's Cursor — opaque here as everywhere (ADR-0007), so its presence
     * is the whole of what is read.
     */
    const [connection] = reader.connections;
    expect(connection?.searchParams.get("cursor")).toEqual(expect.any(String));
  } finally {
    const exit = await instance.stop();
    await browser.close();
    assertPromptExit(exit);
  }
});

/** A Connection held on the wire, and the two moments a scenario needs of it. */
interface HeldConnection {
  /** Settles once the hydrated page has actually asked for its Connection. */
  opened: Promise<void>;
  /** Let it through. Every later Connection — a reconnect — goes straight through. */
  release: () => void;
}

/**
 * Stall the first `/api/sse` request this page makes, and let every one after it go.
 *
 * Interception is the only way to make the window wide enough to Publish into: the alternative
 * is to Publish at a guessed moment and hope it lands between the render and the stream, which
 * is a scenario that passes for the wrong reason most of the time. The request is `continue`d
 * rather than fulfilled — what is being tested is the App's own answer, held back a moment, not
 * a stream this test wrote.
 */
async function holdTheConnection(reader: Reader): Promise<HeldConnection> {
  let announceOpened!: () => void;
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (announceOpened = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = false;

  await reader.page.route(
    (url) => url.pathname === "/api/sse",
    async (route) => {
      if (!held) {
        held = true;
        announceOpened();
        await released;
      }
      await route.continue();
    },
  );

  return { opened, release };
}
