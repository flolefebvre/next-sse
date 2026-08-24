import type { EventSourceConstructor, EventSourceLike, MessageEventLike } from "./core.js";

/** The `readyState` values of the `EventSource` interface, which the double answers with too. */
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

type Listener = (event: MessageEventLike) => void;

/**
 * An `EventSource`-shaped double a test drives by hand: no network, no timers, every block
 * delivered exactly when the test says so.
 *
 * It exists because no DOM shim ships `EventSource` — neither jsdom nor happy-dom registers
 * one — so a jsdom test is a mocked `EventSource` by construction; the core takes its
 * constructor by injection precisely so that the mock is the seam rather than a global patch.
 *
 * It ships from `./testing` (ADR-0009) so consumers test their components the same way, which
 * makes every member of it public API: nothing is added here that a consumer test would not
 * drive.
 */
export class FakeEventSource implements EventSourceLike {
  readonly url: string;
  readyState: number = CONNECTING;
  private readonly listeners = new Map<string, Set<Listener>>();
  /**
   * The last event ID buffer of the SSE grammar, modelled the way the browser holds it: any
   * block carrying an `id:` sets it, every event dispatched afterwards is stamped with it, and
   * it survives the reconnects the source makes on its own — which is precisely what makes the
   * `ready` of a resumed stream tell the client core that a replay is on its way.
   */
  private lastEventId = "";

  constructor(url: string) {
    this.url = url;
    this.readyState = OPEN;
  }

  /** The Channels this Connection asked for, read back off the URL the core built. */
  get channels(): string[] {
    return this.query.getAll("channel");
  }

  /** The Cursor this Connection resumes from, or `null` when it opened live-only. */
  get cursor(): string | null {
    return this.query.get("cursor");
  }

  private get query(): URLSearchParams {
    return new URL(this.url, "http://localhost").searchParams;
  }

  addEventListener(type: string, listener: (event: MessageEventLike) => void): void {
    const forType = this.listeners.get(type) ?? new Set<Listener>();
    forType.add(listener);
    this.listeners.set(type, forType);
  }

  close(): void {
    this.readyState = CLOSED;
  }

  /**
   * Deliver one block of the given type, the way the browser dispatches it: a block with an
   * `id:` moves the last event ID buffer, and every event carries whatever the buffer holds.
   */
  emit(type: string, data: unknown = {}, id = ""): void {
    if (id !== "") this.lastEventId = id;
    const event: MessageEventLike = {
      data: JSON.stringify(data),
      lastEventId: this.lastEventId,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** The Control event that opens every stream. */
  ready(data: Record<string, unknown> = { cursor: "cursor-0", refused: [] }): void {
    this.emit("ready", data);
  }

  /** The Control event that ends the replay, whether or not anything was replayed. */
  caughtUp(): void {
    this.emit("caught-up");
  }

  /**
   * One Message, framed the way the wire frames it: the unnamed block, the envelope in the
   * data, the Cursor as the event id.
   */
  message(channel: string, event: string, payload: unknown, cursor = ""): void {
    this.emit("message", { channel, event, payload }, cursor);
  }

  /**
   * The pipe broke and the browser is retrying on its own — the ordinary transient drop, which
   * the core watches rather than owns. The last event ID buffer is untouched: it is what the
   * browser puts in the `Last-Event-ID` of the request it makes by itself, and what the blocks
   * of the resumed stream are stamped with.
   */
  drop(): void {
    this.readyState = CONNECTING;
    this.emit("error");
  }

  /**
   * The server answered something that is not a stream, so the browser gave up for good. This
   * is the case the core owns.
   */
  fail(): void {
    this.readyState = CLOSED;
    this.emit("error");
  }
}

/**
 * A constructor to put where the browser's `EventSource` would be, and the list of every
 * Connection opened through it, in order.
 *
 * Counting Connections is what most of these tests are about — one for many hooks, one across
 * a Strict Mode burst — so the recorder is the fixture, not an assertion helper bolted on. It
 * is two members and no more: this is public API from `./testing`, and every one of them is a
 * promise the package then keeps.
 */
export function fakeEventSources(): {
  EventSource: EventSourceConstructor;
  opened: FakeEventSource[];
} {
  const opened: FakeEventSource[] = [];

  return {
    EventSource: class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        opened.push(this);
      }
    },
    opened,
  };
}
