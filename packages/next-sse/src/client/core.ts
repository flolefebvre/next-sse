/**
 * Where a Connection stands, as the hooks report it (ADR-0007).
 *
 * The core reaches `connecting`, `live` and `reconnecting` today. `replaying` needs replay and
 * `refused` needs Authorize; both arrive with the ticket that builds them.
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
  /** One Message on that Channel: the declared event name, and the payload as published. */
  onMessage(event: string, payload: unknown): void;
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

interface Subscriber extends Subscription {
  status: Status;
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
 * The heartbeat watchdog, the max lifetime and the page-lifecycle handling of ADR-0004 belong
 * to the Connection-lifecycle ticket and are not here.
 */
export function createCore({ url, eventSource }: CoreOptions): Core {
  const Connection = eventSource ?? globalThis.EventSource;
  const subscribers = new Set<Subscriber>();

  let source: EventSourceLike | undefined;
  let open: ReadonlySet<string> = new Set();
  let live = false;
  let scheduled = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
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

  function setAll(status: Status): void {
    for (const subscriber of subscribers) setStatus(subscriber, status);
  }

  function wanted(): Set<string> {
    return new Set([...subscribers].map((subscriber) => subscriber.channel));
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
    source?.close();
    source = undefined;
    live = false;
  }

  function openSource(channels: ReadonlySet<string>): void {
    open = channels;
    live = false;

    const query = new URLSearchParams();
    for (const channel of channels) query.append("channel", channel);
    if (lastEventId !== undefined) query.set("cursor", lastEventId);
    const opened = new Connection(`${url}?${query.toString()}`);
    source = opened;
    setAll(attempt === 0 ? "connecting" : "reconnecting");

    /**
     * `ready` is the Instance saying it accepted this Connection, which is what ends a retry
     * cycle. Its Cursor is the Connection's position as the Instance settled it — the one this
     * client asked for, the log's tail for a live-only connect, or a fresh tail when the one it
     * brought was gone — and taking it as it comes is what keeps a client that never receives a
     * Message reconnecting from a position rather than from nothing. `refused` belongs to
     * Authorize, and is not read yet.
     */
    opened.addEventListener("ready", (event) => {
      attempt = 0;
      const { cursor } = JSON.parse(event.data) as { cursor?: unknown };
      if (typeof cursor === "string" && cursor !== "") lastEventId = cursor;
    });

    /**
     * A Message is the unnamed block (ADR-0004): one listener carries every event name a
     * Channel declares, including the ones a Handle publishes dynamically.
     */
    opened.addEventListener("message", (event) => {
      if (event.lastEventId !== "") lastEventId = event.lastEventId;
      const { channel, event: name, payload } = JSON.parse(event.data) as Envelope;
      for (const subscriber of subscribers) {
        if (subscriber.channel === channel) subscriber.onMessage(name, payload);
      }
    });

    opened.addEventListener("caught-up", () => {
      live = true;
      setAll("live");
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
   * same subscribe — Strict Mode, a re-render with the same Handle — cost nothing.
   */
  function reconcile(): void {
    const channels = wanted();
    if (source !== undefined && sameSet(channels, open)) return;

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

  return {
    subscribe(subscription) {
      const subscriber: Subscriber = { ...subscription, status: "connecting" };
      subscribers.add(subscriber);

      /**
       * A hook mounting onto a Connection that already carries its Channel is live at once:
       * nothing will reopen for it, so nothing else would ever tell it so.
       */
      if (live && open.has(subscriber.channel)) setStatus(subscriber, "live");
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

function sameSet(one: ReadonlySet<string>, other: ReadonlySet<string>): boolean {
  return one.size === other.size && [...one].every((value) => other.has(value));
}
