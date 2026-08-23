import type { Connection, Instance } from "./instance.js";
import { encodeControl, encodeMessage, encodeRetry, type StoredMessage } from "./wire.js";

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
 * is deliberately not used: the package imports nothing from Next.js.
 */
export function createGetHandler(instance: Instance): (request: Request) => Promise<Response> {
  return async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const channels = new Set(url.searchParams.getAll("channel"));

    if (channels.size === 0) {
      return new Response(
        "A Connection must name the Channels it subscribes to: ?channel=<name>.",
        {
          status: 400,
        },
      );
    }

    return new Response(streamFor(instance, request, channels), { headers: HEADERS });
  };
}

function streamFor(
  instance: Instance,
  request: Request,
  channels: ReadonlySet<string>,
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

      /**
       * Until the opening sequence is out, a Message this Connection is subscribed to waits:
       * `ready` is the first chunk of the stream, whatever the log does in the meantime.
       */
      const waiting: StoredMessage[] = [];
      let opening = true;
      const connection: Connection = {
        channels,
        deliver(entry) {
          if (opening) waiting.push(entry);
          else write(encodeMessage(entry));
        },
      };

      disconnect = await instance.open(connection);

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
       * A live-only Connection adopts the log's tail as its Cursor (ADR-0004), so that a client
       * that never received a Message still reconnects from a position rather than from
       * nothing. Authorize, and with it a non-empty `refused`, arrives with its own ticket.
       */
      const cursor = await instance.transport.tail();
      write(encodeControl("ready", { cursor, refused: [] }));
      write(encodeRetry(RETRY_MS));
      write(encodeControl("caught-up"));

      opening = false;
      for (const entry of waiting) write(encodeMessage(entry));
      waiting.length = 0;
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
