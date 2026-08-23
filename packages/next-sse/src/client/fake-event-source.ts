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
 * ADR-0009 has it shipping from `./testing` so consumers test their components the same way;
 * it is internal until that ticket, and promoting it is a re-export.
 */
export class FakeEventSource implements EventSourceLike {
  readonly url: string;
  readyState: number = CONNECTING;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    this.readyState = OPEN;
  }

  /** The Channels this Connection asked for, read back off the URL the core built. */
  get channels(): string[] {
    return new URL(this.url, "http://localhost").searchParams.getAll("channel");
  }

  addEventListener(type: string, listener: (event: MessageEventLike) => void): void {
    const forType = this.listeners.get(type) ?? new Set<Listener>();
    forType.add(listener);
    this.listeners.set(type, forType);
  }

  close(): void {
    this.readyState = CLOSED;
  }

  /** Deliver one block of the given type, the way the browser dispatches it. */
  emit(type: string, data: unknown = {}, lastEventId = ""): void {
    const event: MessageEventLike = { data: JSON.stringify(data), lastEventId };
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
   * the core watches rather than owns.
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
 * A constructor to hand the core, and the list of every Connection it opened, in order.
 *
 * Counting Connections is what most of these tests are about — one for many hooks, one across
 * a Strict Mode burst — so the recorder is the fixture, not an assertion helper bolted on.
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
