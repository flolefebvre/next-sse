import { expect, test } from "vitest";

import {
  openBrowser,
  readerIn,
  rowsOf,
  waitForRow,
  waitForText,
  waitUntilLive,
  RECONNECT_WAIT_MS,
  type Reader,
} from "./harness/browser.js";
import { publish } from "./harness/demo.js";
import { assertPromptExit, startInstance } from "./harness/example.js";
import { startProxy } from "./harness/proxy.js";

/**
 * A Cursor no log could ever have minted, which is how this scenario manufactures a `reset`: the
 * spelling is the handler's own (`handler.test.ts`), and what the Transport answers for it is
 * `gone` rather than a rejection — a `200` stream carrying the tail (ADR-0005).
 */
const REFUSED = "not-a-cursor";

/** What the server rendered, what was Published while the Cursor was being refused, and after. */
const RENDERED = "rendered into the page";
const INTO_THE_GAP = "published while the Cursor was refused";
const AFTER_THE_RESET = "published once the page was live again";
const AFTER_THE_RECONNECT = "published once the pipe was back";

/** Long enough for a `next start` boot, a browser, and a Connection that has to come back twice. */
const PATIENCE_MS = 120_000;

/**
 * The Cursor a reader cannot use, in a real browser: the page is told its position is unusable,
 * refetches its state, comes back live on the position the `reset` named — and is never told
 * again.
 *
 * No topology of this harness produces a `reset` by itself. A log deep enough to drop a Cursor
 * under a running page is minutes of Publishing, and an Instance dying takes nothing with it: the
 * log is shared, so the survivor serves the very Cursor the dead one minted. So the refusal is
 * manufactured where a scenario may honestly reach — on the wire, not in the App: the first
 * `/api/sse` this page makes is held, and let through with its `cursor` rewritten to something
 * no log minted (ADR-0009 puts no test-only path through this App). The Instance answers what it
 * answers any client in that state, and everything after it is the client's own.
 *
 * What that buys is the one client branch no browser scenario had yet. `reset` is not a replay:
 * the position it names is the tail the Instance adopted, so the Message Published while the
 * Connection was held is *behind* that tail and no Connection will ever deliver it. It can only
 * reach the screen one way — the App reading its state again, which is what the provider's
 * default answer to a `reset` sets off (ADR-0007). Seeing it on the list is the proof the refetch
 * happened, and seeing the list hold every Message once is the proof nothing was lost, doubled or
 * left over from before.
 *
 * The second half is the promise `reset` makes about the *next* Connection. A client that adopted
 * nothing would come back on the Cursor it was just refused, meet the same refusal, and refetch
 * for ever; so the pipe is cut at the network once the page is live, and what the browser opens
 * by itself has to carry a position the Instance accepts in silence. Which Connection met a
 * `reset` is read from the browser — every `EventSource` the page opens records the event
 * passively, altering nothing — and what each Connection asked for is read off the route that
 * sent it.
 */
test(
  "a reader whose Cursor is refused refetches and comes back live",
  { timeout: PATIENCE_MS },
  async () => {
    const instance = await startInstance();
    const proxy = await startProxy(instance.url);
    const browser = await openBrowser();

    try {
      const reader = await readerIn(browser);
      const { page } = reader;
      await recordResets(reader);
      const refusal = await refuseTheFirstCursor(reader);

      await publish(instance.url, RENDERED);
      await reader.open(proxy.url);

      /**
       * The page is hydrated and its Connection is on the wire, held: what is on screen is the
       * server render alone, and the Snapshot's Cursor is the one about to be thrown away.
       */
      await refusal.opened;
      expect(await rowsOf(page, "messages")).toEqual([RENDERED]);

      /**
       * Published before the refused Connection is let through, so the tail the Instance adopts
       * is past it: no `reset`, no replay and no live feed will carry this Message. The page can
       * only have it by reading the App's state again.
       */
      await publish(instance.url, INTO_THE_GAP);
      refusal.release();

      await waitForRow(page, "messages", INTO_THE_GAP, RECONNECT_WAIT_MS);
      await waitUntilLive(page, RECONNECT_WAIT_MS);

      /**
       * Live again, on the Connection the `reset` set off. The assertion waits for a Message
       * Published *after* that: anything the recovery was going to deliver twice has been
       * delivered by the time this one arrives.
       */
      await publish(instance.url, AFTER_THE_RESET);
      await waitForRow(page, "messages", AFTER_THE_RESET);
      expect(await rowsOf(page, "messages")).toEqual([RENDERED, INTO_THE_GAP, AFTER_THE_RESET]);

      /**
       * And the ordinary accident, on top of the recovery: the pipe dies with nothing said about
       * it, and the browser comes back by itself — on the position the `reset` handed this
       * client, since there is nothing else it could be holding.
       */
      const beforeTheCut = refusal.sent.length;
      proxy.cut();
      await waitForText(page, "status", "reconnecting", RECONNECT_WAIT_MS);
      await waitUntilLive(page, RECONNECT_WAIT_MS);

      await publish(instance.url, AFTER_THE_RECONNECT);
      await waitForRow(page, "messages", AFTER_THE_RECONNECT);
      expect(await rowsOf(page, "messages")).toEqual([
        RENDERED,
        INTO_THE_GAP,
        AFTER_THE_RESET,
        AFTER_THE_RECONNECT,
      ]);

      /**
       * What every Connection asked for, as the route sent it: the first one the refusal this
       * scenario manufactured, and every one after it a position of the client's own — opaque, so
       * that it is one at all is the whole of what is read (ADR-0007), and that it is not the
       * refused one is the point.
       */
      expect(refusal.sent.length).toBeGreaterThan(beforeTheCut);
      const [refused, ...after] = refusal.sent;
      expect(refused?.searchParams.get("cursor")).toBe(REFUSED);
      for (const connection of after) {
        expect(connection.searchParams.get("cursor")).toEqual(expect.any(String));
        expect(connection.searchParams.get("cursor")).not.toBe(REFUSED);
      }

      /**
       * And the claim the whole second half is for: one `reset` in this page's life, on the
       * Connection that was refused. A second one would mean a client sent back into the gap it
       * was told about — the failure `reset` names a position to prevent.
       */
      const met = await resetsMet(reader);
      expect(met.length).toBeGreaterThan(1);
      expect(met.filter((connection) => connection.reset)).toEqual([met[0]]);
    } finally {
      const exit = await instance.stop();
      await proxy.close();
      await browser.close();
      assertPromptExit(exit);
    }
  },
);

/** The refusal this scenario manufactures, and what the route saw of every Connection. */
interface Refusal {
  /** Settles once the hydrated page has asked for its Connection, and it is being held. */
  opened: Promise<void>;
  /** Let it through, with its Cursor rewritten. Every Connection after it goes as it was. */
  release: () => void;
  /** What was actually sent upstream, in order: one URL per `/api/sse` request this page made. */
  sent: URL[];
}

/**
 * Hold the first `/api/sse` this page makes, then let it through asking to resume from a position
 * no log minted — and let every request after it go untouched.
 *
 * The rewrite is invisible to the client: it holds the Cursor its Snapshot gave it, and learns
 * only what the Instance tells it. Holding is what makes the window a scenario can Publish into
 * rather than a moment to guess at, exactly as the handoff-window scenario next door does; and
 * the request is `continue`d rather than fulfilled because what is being tested is the App's own
 * answer to a Cursor it cannot serve, not a stream this test wrote.
 */
async function refuseTheFirstCursor(reader: Reader): Promise<Refusal> {
  let announceOpened!: () => void;
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (announceOpened = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const sent: URL[] = [];
  let held = false;

  await reader.page.route(
    (url) => url.pathname === "/api/sse",
    async (route) => {
      const asked = new URL(route.request().url());
      if (held) {
        sent.push(asked);
        await route.continue();

        return;
      }

      held = true;
      announceOpened();
      await released;
      asked.searchParams.set("cursor", REFUSED);
      sent.push(asked);
      await route.continue({ url: asked.href });
    },
  );

  return { opened, release, sent };
}

/** One Connection this page opened, and whether the Instance ever refused its Cursor. */
interface Met {
  url: string;
  reset: boolean;
}

/**
 * Record, from inside the page, which Connection met a `reset`.
 *
 * There is no reading it off the route: an `/api/sse` answer never ends, and `route.fetch` hands
 * back a body it has finished reading — the scenario would hang on the first Connection it tried
 * to look inside. So the observation is made where the event is delivered, by an `EventSource`
 * that listens to `reset` alongside the client core and does nothing else with it. It suppresses
 * nothing, changes no timing and adds no branch to anything the page ships: what it watches is
 * the same stream the core is reading.
 *
 * A count of Connections would not do instead. Every `reset` reopens (ADR-0004), so a second one
 * would show up as a request — but so does the fresh Snapshot the refetch renders, and a scenario
 * asserting on how many `/api/sse` there were could not say which reason it was counting.
 */
async function recordResets(reader: Reader): Promise<void> {
  await reader.page.addInitScript(() => {
    const Native = window.EventSource;
    const met: Met[] = [];
    (window as unknown as { __met: Met[] }).__met = met;

    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        const mine: Met = { url: String(url), reset: false };
        met.push(mine);
        this.addEventListener("reset", () => {
          mine.reset = true;
        });
      }
    };
  });
}

/** Every Connection this page opened, in the order it opened them, as the browser saw them. */
function resetsMet(reader: Reader): Promise<Met[]> {
  return reader.page.evaluate(() => (window as unknown as { __met: Met[] }).__met);
}
