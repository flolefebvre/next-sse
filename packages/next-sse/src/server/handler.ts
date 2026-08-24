import type { Connection, Instance } from "./instance.js";
import { encodeControl, encodeMessage, encodeRetry } from "./wire.js";

/** What ADR-0004 tells the client core to wait before reconnecting on its own, in milliseconds. */
const RETRY_MS = 3000;

/** Exactly the headers ADR-0004 names, and nothing else. */
const HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

/**
 * The `GET` an App re-exports from its route file. It is deliberately thin: it reads the
 * Channels off the query, opens one Connection on the Instance, and writes what the Instance
 * hands it.
 *
 * Its first act is reading `request.url`, and that is load-bearing. Under Cache Components a
 * `GET` handler is executed at build time and only stops being prerendered once it touches
 * request data, so reading the URL — which this handler needs anyway — is what bails out,
 * before anything is registered or subscribed. `export const dynamic` is not an option: it is
 * a build error under Cache Components. `connection()` from `next/server` would work too, and
 * is deliberately not used: the server half imports nothing from Next.js — the client's default
 * Reset (`client/router-reset.tsx`) is the package's one `next/navigation` import, and it is a
 * `'use client'` module.
 */
export function createGetHandler(instance: Instance): (request: Request) => Promise<Response> {
  return async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const channels = new Set(url.searchParams.getAll("channel").filter((name) => name !== ""));

    if (channels.size === 0) {
      return new Response(
        "A Connection must name the Channels it subscribes to: ?channel=<name>.",
        {
          status: 400,
        },
      );
    }

    return new Response(streamFor(instance, request, channels, cursorOf(request, url)), {
      headers: HEADERS,
    });
  };
}

/**
 * Where this Connection resumes from, or `undefined` for a live-only connect.
 *
 * `Last-Event-ID` wins over `?cursor=` (ADR-0004): the header is what the browser echoes back
 * from the last block it received, so it is by definition no older than the URL the client core
 * built when it opened the Connection. Neither is inspected any further — the Cursor is opaque
 * to the Instance, and a value this log cannot serve is answered with `reset` on a `200` stream
 * rather than a `400` the core would retry forever.
 */
function cursorOf(request: Request, url: URL): string | undefined {
  const given = [request.headers.get("last-event-id"), url.searchParams.get("cursor")];

  return given.find((value) => value !== null && value !== "") ?? undefined;
}

function streamFor(
  instance: Instance,
  request: Request,
  channels: ReadonlySet<string>,
  after: string | undefined,
): ReadableStream<Uint8Array> {
  let closed = false;
  let disconnect: (() => void) | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  /**
   * The one teardown, whichever way the Connection ended. `endStream` is false when the stream
   * was cancelled under us — there is nothing left to close, and closing it would throw.
   */
  const dispose = (endStream: boolean): void => {
    if (closed) return;
    closed = true;
    request.signal.removeEventListener("abort", abort);
    disconnect?.();
    if (endStream) controller?.close();
  };

  function abort(): void {
    dispose(true);
  }

  return new ReadableStream<Uint8Array>({
    async start(streamController) {
      controller = streamController;
      const write = (bytes: Uint8Array): void => {
        if (!closed) streamController.enqueue(bytes);
      };

      const connection: Connection = {
        channels,
        deliver: (entry) => write(encodeMessage(entry)),
        reset: () => write(encodeControl("reset")),
        caughtUp: () => write(encodeControl("caught-up")),
      };

      const opening = await instance.open(connection, { after });
      disconnect = opening.close;

      /**
       * The client may have gone while the Instance was opening the Connection. When the stream
       * was already cancelled, teardown has run without a Connection to release, so this one
       * releases itself; otherwise it is an ordinary abort.
       */
      if (closed) {
        disconnect();

        return;
      }
      if (request.signal.aborted) {
        dispose(true);

        return;
      }
      request.signal.addEventListener("abort", abort);

      /**
       * The opening sequence, in the order ADR-0004 fixes it: `ready` as the first chunk of the
       * stream whatever the log is doing, then the retry, then whatever `start` produces — a
       * `reset`, the replay, `caught-up` — through the Connection's own methods.
       */
      write(encodeControl("ready", { cursor: opening.cursor, refused: [] }));
      write(encodeRetry(RETRY_MS));
      await opening.start();
    },

    /**
     * The client went away: Next aborts the pipe on the response's `close`, which cancels this
     * stream, and aborts `request.signal` for good measure. Either path leads here, and the
     * Connection leaves the table exactly once.
     */
    cancel() {
      dispose(false);
    },
  });
}
