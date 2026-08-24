import type { Connection, InstanceState } from "./instance.js";

/** How long a Drain spreads its Connections over when the App configures nothing (ADR-0011). */
export const DEFAULT_DRAIN_MS = 3000;

/** The signals a Drain is installed on: the two an orchestrator ends a process with. */
const SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * A Connection this Instance will not open because it is shutting down.
 *
 * It exists so that the one race the Drain has cannot happen: a request that passed the
 * handler's own draining check and is inside `open()`, waiting on the log, when the flag flips.
 * Walking the Connection table would miss it, nothing would ever end it, and the Drain would
 * wait for a table that never empties. Rejecting where the Connection would have been
 * registered is what keeps "every Connection is ended" a claim about a table nothing enters.
 */
export class DrainingError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DrainingError";
  }
}

/**
 * Shut this Instance down: refuse, spread, close (ADR-0011).
 *
 * The promise is memoised, so a second signal — or an App sequencing its own shutdown on
 * `sse.drain()` while the handler is already draining — joins the Drain in flight rather than
 * starting a second one. It resolves when the Transport close has settled, which is what a
 * custom server waits on before it lets the process go.
 */
export function drain(state: InstanceState): Promise<void> {
  state.drainPromise ??= run(state);

  return state.drainPromise;
}

async function run(state: InstanceState): Promise<void> {
  state.draining = true;
  await emptied(state);
  await state.transport.close();
}

/**
 * Every Connection ended, spread with full jitter over the window: each one is given its own
 * `Math.random() * window`, so an Instance's whole table does not re-Authorize and replay
 * against the survivors in the same instant. A window of `0` ends them all in this tick, which
 * is a value like any other rather than the feature turned off.
 *
 * The wait is driven by the Connections leaving the table — `connectionLeft` resolves it — and
 * never polled: a Connection ended while it was still opening leaves on its own schedule (the
 * ending is carried out after its `ready`, ADR-0004), and the table is the one place that knows
 * when the last of them is gone.
 *
 * There is deliberately no deadline. The only thing that could hold this open is a Connection
 * still inside `open()`, waiting on a log that never answers — and no Transport does that: the
 * Redis one rejects while the backend is away (ADR-0006), and a rejected `open()` never
 * registered anything to wait for.
 */
function emptied(state: InstanceState): Promise<void> {
  if (state.held.size === 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    state.emptied = resolve;
    for (const held of state.held.values()) end(held.connection, state.drainWindow);
  });
}

function end(connection: Connection, window: number): void {
  if (window === 0) {
    connection.reconnect();

    return;
  }

  const timer = setTimeout(() => {
    connection.reconnect();
  }, Math.random() * window);
  timer.unref?.();
}

/**
 * One Connection has left the table. It is the Drain's only clock: when the last one is gone,
 * the Transport may be closed. Outside a Drain it is nothing at all — Connections leave the
 * table all day long.
 */
export function connectionLeft(state: InstanceState): void {
  if (state.emptied === undefined || state.held.size > 0) return;

  const resolve = state.emptied;
  state.emptied = undefined;
  resolve();
}

/**
 * Listen for the signals an orchestrator ends a process with, once, when the Instance is
 * created (ADR-0011).
 *
 * Node runs every listener for a signal, so Next.js's own — which awaits `server.close()` —
 * stays in place, and the two are self-synchronizing: the Drain ending the SSE responses is
 * exactly what lets that `close()` resolve. Nothing here exits the process; that is Next's to
 * do, and a library that called `process.exit` would cut the App's own shutdown short.
 *
 * The listener is registered with `on` rather than `once` on purpose: a second signal mid-Drain
 * must reach the memoised promise, not Node's default handler, which would kill the process
 * with the Connections still open.
 *
 * It hands back the way to remove what it installed, which is what a test that asserts the
 * installation has to leave behind.
 */
export function installSignalHandlers(state: InstanceState): () => void {
  const listener = (): void => {
    drain(state).catch((error: unknown) => {
      console.error(
        "next-sse: this Instance was signalled and its Drain failed, so some Connections may " +
          "have been left for the shutdown to cut.",
        error,
      );
    });
  };

  for (const signal of SIGNALS) process.on(signal, listener);

  return () => {
    for (const signal of SIGNALS) process.off(signal, listener);
  };
}
