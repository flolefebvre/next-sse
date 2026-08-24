import type { ChannelRecord, DeclaredAuthorize } from "../internal/channel.js";
import { matchPattern } from "../internal/pattern.js";

import type { Connection, Instance } from "./instance.js";
import { encodeControl, encodeMessage, encodeRetry, type Ready } from "./wire.js";

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
 * Channels off the query, asks the App which of them this request may have, opens one Connection
 * on the Instance for those, and writes what the Instance hands it.
 *
 * Authorize is the handler's business and nobody else's (ADR-0003). The Instance, the Transport
 * and the delivery path never see it: the Connection they hold is the surviving Channels, and
 * the refused ones exist only as the list `ready` carries. That is also why it runs on every
 * reconnect for free — a reconnect is another `GET`.
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

    /**
     * Authorize runs here: after the one failure that has nothing to name, and before the
     * Instance is asked for anything. Nothing has been written yet, so a decision still has
     * both answers open — a `200` carrying the refusals in band, or a `500` when the App's own
     * code could not reach one at all.
     */
    let decided: Decision;
    try {
      decided = await decide(instance, request, channels);
    } catch (error) {
      console.error(
        "next-sse: this App's context() or authorize() threw while a Connection was opening, " +
          "so no decision was reached and the Connection was answered 500.",
        error,
      );

      return new Response(
        "This App could not decide whether this Connection may subscribe. Try again.",
        { status: 500 },
      );
    }

    /**
     * Every Channel refused is still a `200` (ADR-0003): a browser `EventSource` sees neither
     * the status nor the body of anything else, so the only way to name what was refused is in
     * band. There is nothing to stream afterwards, so the stream carries `ready` and ends —
     * with no `retry:`, because the core closes this Connection itself rather than reopening a
     * stream that would say the same thing again.
     */
    if (decided.allowed.size === 0) {
      return new Response(refusedStream({ refused: decided.refused }), { headers: HEADERS });
    }

    return new Response(streamFor(instance, request, decided, cursorOf(request, url)), {
      headers: HEADERS,
    });
  };
}

/** What Authorize settled for one Connection, before anything of it was opened or written. */
interface Decision {
  /** The Channels that passed: the ones this Connection is opened with. */
  readonly allowed: ReadonlySet<string>;
  /** The ones that did not, in the order they were asked for. */
  readonly refused: string[];
  /** What this App calls the holder of this Connection, when it configured a `key`. */
  readonly key: string | undefined;
}

/**
 * The App's decisions for this request: its context built once, its Key derived once, and its
 * Authorize run once per requested Channel.
 *
 * They run concurrently because they are independent App code — a session read and one database
 * lookup per Channel should cost one round trip, not one each — and every one of them is given
 * the same context object. A Channel this App's Registry does not describe is refused exactly
 * like one it denies: the client is told the same thing either way, and the mismatch is a
 * server-side warning, because it is the App's own bug and not the client's business (ADR-0003).
 *
 * Whatever throws in here throws out of here. A `context()` that could not read the session and
 * an `authorize()` whose database was down are failures to reach a decision, not decisions:
 * folding them into a refusal would turn a blip into a Channel the page reports as refused until
 * something else reopens the Connection.
 */
async function decide(
  instance: Instance,
  request: Request,
  channels: ReadonlySet<string>,
): Promise<Decision> {
  const declarations = instance.registry ?? {};
  const ctx = await instance.context?.(request);
  const key = instance.key?.(ctx as never);

  const decisions = await Promise.all(
    [...channels].map(async (name) => [name, await allows(declarations, name, ctx)] as const),
  );

  return {
    allowed: new Set(decisions.filter(([, passed]) => passed).map(([name]) => name)),
    refused: decisions.filter(([, passed]) => !passed).map(([name]) => name),
    key,
  };
}

/** Whether this App lets this Connection have this Channel, whatever the Channel's params are. */
async function allows(declarations: ChannelRecord, name: string, ctx: unknown): Promise<boolean> {
  for (const declaration of Object.values(declarations)) {
    const params = matchPattern(declaration.pattern, name);
    if (params === undefined) continue;

    return await call(declaration.authorize, params, ctx);
  }

  console.warn(
    `next-sse: a Connection asked for the Channel "${name}", and no pattern in this App's ` +
      `Registry makes that name — it was refused the way a denied Channel is. This is a ` +
      `Registry mismatch: a client is subscribing to something this App does not declare.`,
  );

  return false;
}

/**
 * The one place a declared Authorize is called, and so the one place its two unknowables — the
 * params of its own pattern, and the App's Ctx — are put back. Both are known here and nowhere
 * else, which is why the cast lives here rather than in the type of a declaration.
 */
function call(
  authorize: DeclaredAuthorize,
  params: Record<string, string>,
  ctx: unknown,
): boolean | Promise<boolean> {
  return (
    authorize as (params: Record<string, string>, ctx: unknown) => boolean | Promise<boolean>
  )(params, ctx);
}

/**
 * The whole stream of a Connection that was refused every Channel it asked for: `ready` naming
 * them, and the end of the stream. No Connection is registered on the Instance, nothing is read
 * from the log, and no Cursor is named — there is no position, because there is nothing here to
 * resume.
 */
function refusedStream(ready: Ready): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeControl("ready", ready));
      controller.close();
    },
  });
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
  { allowed, refused, key }: Decision,
  after: string | undefined,
): ReadableStream<Uint8Array> {
  let closed = false;
  let disconnect: (() => void) | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let heartbeats: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;

  /**
   * The one teardown, whichever way the Connection ended. `endStream` is false when the stream
   * was cancelled under us — there is nothing left to close, and closing it would throw.
   *
   * Every timer this Connection armed is cleared here, and here only: a heartbeat still firing
   * at a stream nobody reads is a leak that outlives the client by the length of the process.
   */
  const dispose = (endStream: boolean): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeats);
    clearTimeout(lifetime);
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
        channels: allowed,
        key,
        deliver: (entry) => write(encodeMessage(entry)),
        reset: () => write(encodeControl("reset")),
        caughtUp: () => write(encodeControl("caught-up")),
        reconnect: () => {
          write(encodeControl("reconnect"));
          dispose(true);
        },
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
       * stream whatever the log is doing — carrying the Channels Authorize refused, so a page
       * hears about a refusal in the same breath as the Connection opening — then the retry,
       * then whatever `start` produces: a `reset`, the replay, `caught-up`.
       */
      const heartbeat = instance.heartbeat;
      write(encodeControl("ready", { cursor: opening.cursor, refused, heartbeat } satisfies Ready));
      write(encodeRetry(RETRY_MS));

      /**
       * The heartbeat starts with the Connection rather than with its live feed: a replay long
       * enough to matter is exactly when a proxy would otherwise see an idle pipe, and a
       * `heartbeat` carries no `id:`, so it can fall anywhere among the Messages without moving
       * anybody's Cursor. It is unref'd, so a process with nothing else to do can still exit.
       */
      if (heartbeat > 0) {
        heartbeats = setInterval(() => {
          write(encodeControl("heartbeat"));
        }, heartbeat);
        heartbeats.unref?.();
      }

      /**
       * The Connection's own end, armed at the same moment: when it comes, it comes through the
       * one primitive that ends a Connection at all, so the max lifetime, a Kick and a Drain are
       * the same three bytes on the wire and the same teardown behind it.
       */
      const maxLifetime = instance.maxLifetime;
      if (maxLifetime > 0) {
        lifetime = setTimeout(() => {
          connection.reconnect();
        }, spread(maxLifetime));
        lifetime.unref?.();
      }

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

/**
 * One Connection's share of the max lifetime: the configured value ±10 %, drawn per Connection.
 *
 * Without the spread, an Instance that started its Connections together would end them together
 * — a deploy's worth of clients re-Authorizing and replaying against the survivors in the same
 * instant, which is the thundering herd the lifetime exists to prevent rather than to cause.
 */
function spread(milliseconds: number): number {
  return milliseconds * (0.9 + Math.random() * 0.2);
}
