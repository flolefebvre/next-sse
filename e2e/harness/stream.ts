import { EventSource, type MessageEvent } from "undici";

/** The Control events the library sends in band; a scenario waits on them by name. */
const CONTROL_EVENTS = ["ready", "heartbeat", "reconnect", "caught-up", "reset"];

/**
 * The type every Message is dispatched as. Messages are the unnamed blocks of the wire, so the
 * browser gives them the default type; the Channel and the declared event name are in the data.
 */
const MESSAGE = "message";

const DEFAULT_TIMEOUT_MS = 10_000;

/** One event as it arrived on the wire. */
export interface Received {
  name: string;
  data: string;
  lastEventId: string;
}

/** One open Connection, held by a real `EventSource`, as a scenario reads it. */
export interface Stream {
  /** The next event of that name, waiting for it if it has not arrived yet. */
  next(name: string, timeoutMs?: number): Promise<Received>;
  /** End the Connection. Every scenario owes this to the Instance it opened it on. */
  close(): void;
}

/**
 * Open a Connection the way a browser does — the same `EventSource` the client core is built
 * on, so a scenario observes exactly what a client observes, and nothing about how it is
 * served. It waits on `message` and on the Control events, which is every block the wire has.
 */
export function openStream(url: string): Stream {
  const source = new EventSource(url);
  const arrived: Received[] = [];
  const waiting = new Map<string, (received: Received) => void>();

  for (const name of [...CONTROL_EVENTS, MESSAGE]) {
    source.addEventListener(name, (event) => {
      const { data, lastEventId } = event as MessageEvent;
      const received: Received = { name, data: String(data), lastEventId };
      const waiter = waiting.get(name);
      if (waiter) {
        waiting.delete(name);
        waiter(received);
      } else {
        arrived.push(received);
      }
    });
  }

  return {
    next(name: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Received> {
      const at = arrived.findIndex((received) => received.name === name);
      if (at !== -1) return Promise.resolve(arrived.splice(at, 1)[0] as Received);

      return new Promise<Received>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(name);
          reject(new Error(`no "${name}" event within ${String(timeoutMs)}ms`));
        }, timeoutMs);

        waiting.set(name, (received) => {
          clearTimeout(timer);
          resolve(received);
        });
      });
    },
    close() {
      source.close();
    },
  };
}
