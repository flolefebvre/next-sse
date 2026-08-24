import { browserPage, type PageLike } from "./page.js";

/**
 * Where a Connection stands, as the hooks report it (ADR-0007).
 *
 * `refused` is the one that is not about the Connection but about this subscriber's own Channel:
 * the Connection may be live and carrying other Channels perfectly well. It lasts as long as the
 * Connection that was refused — Authorize decides afresh on the next one.
 */
export type Status = "connecting" | "replaying" | "live" | "reconnecting" | "refused";

/** One block off the wire, as much of it as the core reads. */
export interface MessageEventLike {
  readonly data: string;
  readonly lastEventId: string;
}

/**
 * The shape the core needs of an `EventSource`. The browser's satisfies it; so does the double
 * the tests run on, which is the point — the core never reaches for a global.
 */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEventLike) => void): void;
  close(): void;
}

/** How the core makes a Connection. Injected, so a test can hand it anything. */
export type EventSourceConstructor = new (url: string) => EventSourceLike;

/** One subscriber on the shared Connection: a Channel, and where its Messages and status go. */
export interface Subscription {
  /** The Channel name, already resolved from the Registry data the provider carries. */
  readonly channel: string;
  /**
   * Where this subscriber resumes from, when it brought a Snapshot. Subscribing with one makes
   * the shared Connection reopen from it (ADR-0007); without one the subscriber is live-only
   * and is told nothing of a replay until the first `caught-up` after it arrived.
   */
  readonly cursor?: string;
  /** One Message on that Channel: the declared event name, and the payload as published. */
  onMessage(event: string, payload: unknown): void;
  /**
   * This Connection's Cursor was unusable and the log moved on: refetch before going on. A
   * subscriber that gives none falls back to the Connection's own handler, which is the
   * provider's `router.refresh()` unless the App said otherwise (ADR-0007).
   */
  onReset?(): void;
  /**
   * Called whenever this subscriber's view of the Connection changes, and only then. Every
   * subscriber starts at `connecting`, which is therefore never reported: a hook that holds
   * that as its initial state is told nothing until something actually happens.
   */
  onStatus(status: Status): void;
}

export interface CoreOptions {
  /** The SSE route this App serves. The only place the path is configured (ADR-0008). */
  url: string;
  /** Defaults to the browser's `EventSource`. */
  eventSource?: EventSourceConstructor;
  /** The page this core lives in. Defaults to the browser's, and to nothing off it. */
  page?: PageLike;
  /** What a Reset means for subscribers that brought no handler of their own. */
  onReset?: () => void;
}

/**
 * The whole surface the hooks hold. It is one method on purpose: everything else — how many
 * Connections there are, when they reopen, what a retry costs — is the core's business.
 */
export interface Core {
  subscribe(subscription: Subscription): () => void;
}

/** `EventSource.CLOSED`, named rather than imported: the core does not depend on the global. */
const CLOSED = 2;

/** The core's own retry, for a Connection the browser gave up on: 1 s doubling to 30 s. */
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/**
 * How many heartbeats may go missing before the core stops believing the pipe (ADR-0004). Three
 * is one lost block plus the round trip of the next, which no proxy and no scheduler explains.
 */
const WATCHDOG_BEATS = 3;

interface Subscriber extends Subscription {
  status: Status;
  /**
   * Its Cursor has not been spent on a Connection yet. A subscriber that brought one is asking
   * for a reopen, and it stops asking the moment a Connection opens — or the moment it leaves,
   * which is why this is held per subscriber rather than as one pending value: a Cursor whose
   * subscriber is gone must not close a healthy Connection on its behalf.
   */
  unspent: boolean;
  /**
   * True until the first `caught-up` this subscriber lives through. A subscriber that brought
   * no Cursor has no way to tell a replayed Entry from one it already has, so it is told
   * nothing until the Connection is live (ADR-0007); one that brought a Cursor asked for that
   * replay and gets it.
   */
  liveOnly: boolean;
}

/**
 * The framework-free half of the client: one Connection for the whole App, shared by every
 * subscriber, reopened whenever the set of Channels changes.
 *
 * Two rules carry most of it. **Channel-set changes are coalesced on one macrotask tick**
 * (ADR-0004), so the many hooks of one render open one Connection, and React Strict Mode's
 * setup → cleanup → setup burst collapses to one connect — with no development-only branch,
 * because the core never learns that Strict Mode exists. And **there is exactly one way to
 * open a Connection**: `openSource`. A Channel-set change, a retry after the browser gave up,
 * and later a reopen from a Cursor all go through it, so none of them can drift from the
 * others.
 *
 * The Cursor is the third rule, and the core's whole part in gap-free delivery is to carry it:
 * it remembers the last event id it saw — `ready`'s Cursor to begin with, then every Message's
 * `id` — and puts it in the URL of every Connection it opens itself. It never parses it, never
 * compares two of them, and never decides what to replay; the format stays the Transport's
 * (ADR-0001) and the exactly-once cut stays the Instance's (ADR-0005). A native `EventSource`
 * reconnect does the same thing for free through `Last-Event-ID`.
 *
 * **A subscriber that brings a Cursor makes the Connection reopen from it** (ADR-0007), which
 * is how a server render's Snapshot becomes live with no gap. It is a reason to call
 * `openSource`, not a second way to open a Connection: the Cursor is parked as the pending one
 * and the same reconcile that follows a Channel-set change spends it. Two subscribers bringing
 * two different Cursors on one tick is decided by fiat — the last one still asking wins —
 * because the core cannot compare Cursors and must not learn how (ADR-0001). In practice they
 * are the same Cursor, since one render's Snapshots share one request-cached one; and a Cursor
 * that is older than another costs a longer replay, which the reducers absorb, and never a gap.
 *
 * **Everything that ends a Connection ends it through those same two doors.** The heartbeat
 * watchdog — 3× the interval `ready` advertised, with no block of any kind in between — the
 * `reconnect` the Instance sends before it lets a Connection go, and a page put away and
 * brought back all close and reopen through `closeSource` and `openSource`, with the Cursor
 * this client holds. There is no second path, so nothing can reopen without the Cursor, and a
 * Connection reopened for any of those reasons resumes exactly like one reopened for any other.
 */
export function createCore({ url, eventSource, page, onReset }: CoreOptions): Core {
  const Connection = eventSource ?? globalThis.EventSource;
  const lifecycle = page ?? browserPage();
  const subscribers = new Set<Subscriber>();

  let source: EventSourceLike | undefined;
  let open: ReadonlySet<string> = new Set();
  /**
   * What the current Connection was refused, as `ready` named it. It belongs to the Connection
   * and is emptied with every one this core opens: a Channel refused a moment ago is asked for
   * again on the next connect, because that is the only way a Kick or a change of role can ever
   * give it back (ADR-0003).
   */
  let refused: ReadonlySet<string> = new Set();
  let live = false;
  let scheduled = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  /**
   * How often this Connection said it would be heartbeated, and the timer watching for it. The
   * interval is the Instance's, read off `ready`: the two sides cannot be configured apart, and
   * a Connection that is not heartbeated at all (`0`) is one the core does not watch.
   */
  let heartbeat = 0;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  /**
   * The last event id this client saw, and the only thing it stores about position. It travels
   * back untouched: a Connection carries it in the URL, and the Instance decides what it means.
   */
  let lastEventId: string | undefined;

  function setStatus(subscriber: Subscriber, status: Status): void {
    if (subscriber.status === status) return;
    subscriber.status = status;
    subscriber.onStatus(status);
  }

  /**
   * Where the Connection stands, to every subscriber it is actually about. A subscriber whose
   * Channel this Connection refused is not on it: the replay it is carrying and the moment it
   * goes live are somebody else's news, and telling this one would overwrite the one status it
   * has that says something true.
   */
  function setAll(status: Status): void {
    for (const subscriber of subscribers) {
      if (!refused.has(subscriber.channel)) setStatus(subscriber, status);
    }
  }

  function wanted(): Set<string> {
    return new Set([...subscribers].map((subscriber) => subscriber.channel));
  }

  /**
   * The Cursor the subscribers are asking to resume from, or `undefined` when none is. Read
   * from the subscribers that are here now, so that one which arrived and left inside the same
   * tick asks for nothing: leaving is never a reason to reopen.
   */
  function brought(): string | undefined {
    let cursor: string | undefined;
    for (const subscriber of subscribers) {
      if (subscriber.unspent && subscriber.cursor !== undefined) cursor = subscriber.cursor;
    }

    return cursor;
  }

  /**
   * Take the Connection down and cancel anything that was going to bring it back. Every path
   * out of a Connection goes through here, so a retry can never outlive the Connection that
   * scheduled it — a timer firing after the last hook unmounted would reopen a stream nobody
   * is listening to.
   */
  function closeSource(): void {
    clearTimeout(retry);
    retry = undefined;
    clearTimeout(watchdog);
    watchdog = undefined;
    heartbeat = 0;
    source?.close();
    source = undefined;
    live = false;
  }

  /**
   * Something came off the wire, so the pipe is alive and the watchdog starts again. Every block
   * counts, `heartbeat` included and Messages just as much: what is watched is bytes, not
   * heartbeats — a busy Connection proves itself without one.
   *
   * A pipe that has gone quiet is an error nowhere: the browser is holding a socket that will
   * never speak again — a proxy that idled it out, the iOS `EventSource` stuck at `OPEN` — and
   * nothing but this timer will ever say so.
   */
  function touch(): void {
    clearTimeout(watchdog);
    watchdog = undefined;
    if (heartbeat <= 0) return;
    watchdog = setTimeout(() => {
      watchdog = undefined;
      reopen();
    }, heartbeat * WATCHDOG_BEATS);
  }

  /**
   * Bring the Connection back at once, from wherever this client stands: through the same two
   * doors as every other reopen, so the Cursor, the Channel set and the status all come from the
   * one place that knows them. A `reconnect` from the Instance, a watchdog expiry and a page
   * coming back all do this, and not one of them opens a Connection any other way.
   */
  function reopen(): void {
    closeSource();
    const channels = wanted();
    if (channels.size === 0) return;

    openSource(channels, "reconnecting");
  }

  function openSource(channels: ReadonlySet<string>, as?: Status): void {
    open = channels;
    live = false;
    refused = new Set();

    /**
     * A Cursor a subscriber brought outranks the one this client happens to hold: it is the
     * position a server render read its data at, and resuming from it is what closes the
     * handoff window. It is spent here, whichever reason brought the Connection down.
     */
    const resumeFrom = brought() ?? lastEventId;
    for (const subscriber of subscribers) subscriber.unspent = false;

    const query = new URLSearchParams();
    for (const channel of channels) query.append("channel", channel);
    if (resumeFrom !== undefined) query.set("cursor", resumeFrom);
    const opened = new Connection(`${url}?${query.toString()}`);
    source = opened;
    setAll(as ?? (attempt === 0 ? "connecting" : "reconnecting"));

    /**
     * Every block of this Connection, with the watchdog rearmed before the block is read. A
     * block from a Connection this core has already replaced is nobody's news: it neither feeds
     * a subscriber nor keeps a timer alive.
     */
    const on = (type: string, listener: (event: MessageEventLike) => void): void => {
      opened.addEventListener(type, (event) => {
        if (opened !== source) return;
        touch();
        listener(event);
      });
    };

    /**
     * `ready` is the Instance saying it accepted this Connection, which is what ends a retry
     * cycle. Its Cursor is the Connection's position as the Instance settled it — the one this
     * client asked for, the log's tail for a live-only connect, or a fresh tail when the one it
     * brought was gone — and taking it as it comes is what keeps a client that never receives a
     * Message reconnecting from a position rather than from nothing.
     *
     * **A `ready` with no Cursor is the refusal of every Channel, and is read as exactly that.**
     * There is no Connection behind it, so there is no position: this client keeps whatever
     * position it already held and asks the Instance for nothing more. Nothing here should ever
     * become a fetch for the missing value.
     *
     * `refused` is the other half of Authorize (ADR-0003), and it is per Channel: the
     * subscribers of a refused Channel are told, the rest carry on live, and a Connection that
     * was refused everything is closed here — the browser would reconnect to it by itself the
     * moment the server ended the stream, and would be told the same thing forever.
     */
    on("ready", (event) => {
      attempt = 0;
      const {
        cursor,
        refused: names,
        heartbeat: beat,
      } = JSON.parse(event.data) as {
        cursor?: unknown;
        refused?: unknown;
        heartbeat?: unknown;
      };
      if (typeof cursor === "string" && cursor !== "") lastEventId = cursor;
      heartbeat = typeof beat === "number" && beat > 0 ? beat : 0;
      touch();

      refused = new Set(Array.isArray(names) ? names.filter(isString) : []);
      for (const subscriber of subscribers) {
        if (refused.has(subscriber.channel)) setStatus(subscriber, "refused");
      }

      /**
       * Every Channel of this Connection refused: there is nothing left for it to carry. It is
       * closed rather than retried, because retrying is what the core does about a Connection
       * the server could not serve — this one was served, and the answer was no. A hook mounting
       * or unmounting later reopens through the ordinary path, with the whole Channel set, and
       * Authorize decides again.
       */
      if ([...open].every((channel) => refused.has(channel))) {
        closeSource();

        return;
      }

      /**
       * A replay is coming when this Connection asked to resume, and the two ways of asking are
       * both here. Either the core put the Cursor in the URL — which is every Connection it
       * opens once it holds one — or the browser reconnected this stream by itself and sent the
       * last event id it was holding, which is what `ready` arrives stamped with: the SSE last
       * event ID buffer is on every event a source dispatches.
       *
       * Presence is all that is read of it, never its value and never against the one this
       * client holds: what a Cursor means belongs to the Transport that minted it (ADR-0001).
       */
      if (resumeFrom !== undefined || event.lastEventId !== "") setAll("replaying");
    });

    /**
     * The heartbeat is listened for and read no further: what it carries is nothing, and what it
     * means is entirely that it arrived. Registering it is what makes a quiet Connection keep
     * itself alive in the core's eyes — `on` rearms the watchdog on every block, and on a
     * Connection whose Channels have nothing to say this is the only block there is.
     */
    on("heartbeat", () => undefined);

    /**
     * The Instance is ending this Connection on purpose — its max lifetime, a Kick, a Drain —
     * and says so before it goes, which is what makes the cut cost a round trip and never a
     * Message: the core comes straight back with its Cursor rather than waiting out the
     * browser's own retry (ADR-0004).
     */
    on("reconnect", () => {
      reopen();
    });

    /**
     * A Message is the unnamed block (ADR-0004): one listener carries every event name a
     * Channel declares, including the ones a Handle publishes dynamically.
     */
    on("message", (event) => {
      if (event.lastEventId !== "") lastEventId = event.lastEventId;
      const { channel, event: name, payload } = JSON.parse(event.data) as Envelope;
      for (const subscriber of subscribers) {
        if (subscriber.channel !== channel) continue;
        if (!live && subscriber.liveOnly) continue;
        subscriber.onMessage(name, payload);
      }
    });

    on("caught-up", () => {
      live = true;
      for (const subscriber of subscribers) subscriber.liveOnly = false;
      setAll("live");
    });

    /**
     * The Instance could not serve the Cursor this Connection brought, so whatever the App
     * holds is behind a gap it cannot describe: the only honest answer is to fetch the state
     * again. A subscriber that brought its own handler is the one told; the Connection's
     * handler — the provider's `router.refresh()` by default — is called once for all the
     * others, so a page of hooks that said nothing costs one refetch rather than one each. A
     * subscriber whose Channel this Connection refused is not one of them: it was dropped from
     * this Connection, and the gap this Cursor left is not in anything it holds — refetching on
     * its behalf would refresh a route because of a stream it is not on.
     * Reset is not a status (ADR-0007): the Connection is live and stays live.
     */
    on("reset", () => {
      let anyDefault = false;
      for (const subscriber of [...subscribers]) {
        if (refused.has(subscriber.channel)) continue;
        if (subscriber.onReset === undefined) anyDefault = true;
        else subscriber.onReset();
      }
      if (anyDefault) onReset?.();
    });

    opened.addEventListener("error", () => {
      if (opened !== source) return;
      onError(opened.readyState);
    });
  }

  /**
   * Two very different failures arrive as the same event. A pipe that broke leaves the
   * `EventSource` reconnecting on its own — an unthrottled native timer the core would only
   * make worse by taking over. A `readyState` of `CLOSED` means the browser gave up, which
   * happens on any response that is not a stream, and that retry is the core's (ADR-0004):
   * exponential with full jitter, forever, because the library's own non-200s are a `400`
   * (a bug, harmless to retry) and a `503` (which will recover).
   */
  function onError(readyState: number): void {
    if (readyState !== CLOSED) {
      live = false;
      setAll("reconnecting");

      return;
    }

    closeSource();
    setAll("reconnecting");
    const delay = Math.random() * Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** attempt);
    attempt += 1;
    retry = setTimeout(() => {
      retry = undefined;
      const channels = wanted();
      if (channels.size === 0) return;
      openSource(channels);
    }, delay);
  }

  /**
   * Bring the Connection in line with what the subscribers now want. A Channel set that has
   * not changed keeps the Connection it has: this is what makes an unsubscribe followed by the
   * same subscribe — Strict Mode, a re-render with the same Handle — cost nothing. A Cursor
   * parked by a subscriber is the other reason to reopen, and the only one that does not come
   * from the Channel set; leaving is never one, so an unsubscribe alone reopens nothing.
   */
  function reconcile(): void {
    const channels = wanted();
    if (source !== undefined && brought() === undefined && sameSet(channels, open)) return;

    closeSource();
    if (channels.size === 0) {
      open = new Set();

      return;
    }

    openSource(channels);
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      reconcile();
    }, 0);
  }

  /**
   * The page transitions of ADR-0004, and the whole of what they do.
   *
   * A page put away — `pagehide`, or a freeze — has its Connection let go of: a frozen page
   * cannot read a stream, and holding one open costs the Instance a Connection for a client that
   * is not there. Coming back opens one again, and only if there is none: a bfcache restore
   * fires `resume` and `pageshow`, and both mean the same thing, so the second must find nothing
   * left to do.
   *
   * Becoming visible again is not one of those. A tab switch touches no Connection — closing on
   * `visibilitychange` would cost a reconnect and a replay every time the user looks elsewhere,
   * and the watchdog already covers a pipe that died while the tab was in the background. What
   * it does do is stop waiting: a client sitting out a 30-second backoff in a tab the user has
   * just come back to should be trying now.
   */
  lifecycle.on("hide", () => {
    closeSource();
  });

  lifecycle.on("show", () => {
    if (source !== undefined) return;
    reopen();
  });

  lifecycle.on("visible", () => {
    if (retry === undefined) return;
    reopen();
  });

  return {
    subscribe(subscription) {
      const subscriber: Subscriber = {
        ...subscription,
        status: "connecting",
        liveOnly: subscription.cursor === undefined,
        unspent: subscription.cursor !== undefined,
      };
      subscribers.add(subscriber);

      /**
       * A hook mounting onto a Connection that already carries its Channel is live at once:
       * nothing will reopen for it, so nothing else would ever tell it so. It stops being
       * live-only in the same breath — it joined at the live point, so the next replay this
       * Connection carries is one it lived through the beginning of and must not miss. One that
       * brought a Cursor is neither: a Connection is about to reopen on its behalf, and it
       * starts where every subscriber of that Connection starts.
       *
       * A hook mounting onto a Channel this Connection was refused is told that, for the same
       * reason and at once: the Channel set has not changed, so nothing will reopen and no
       * further `ready` will ever reach it — left alone it would report `connecting` for as long
       * as the page lives. There has to be a Connection for that to be the truth; when the last
       * one was closed for being refused everything, the reconcile this subscription schedules
       * is about to open another and Authorize is about to be asked again.
       */
      if (source !== undefined && refused.has(subscriber.channel)) {
        setStatus(subscriber, "refused");
      } else if (live && open.has(subscriber.channel) && subscription.cursor === undefined) {
        subscriber.liveOnly = false;
        setStatus(subscriber, "live");
      }
      schedule();

      return () => {
        subscribers.delete(subscriber);
        schedule();
      };
    },
  };
}

interface Envelope {
  channel: string;
  event: string;
  payload: unknown;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function sameSet(one: ReadonlySet<string>, other: ReadonlySet<string>): boolean {
  return one.size === other.size && [...one].every((value) => other.has(value));
}
