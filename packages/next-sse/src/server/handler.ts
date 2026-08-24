import type { ChannelRecord, DeclaredAuthorize } from "../internal/channel.js";
import { matchPattern } from "../internal/pattern.js";
import { TransportError } from "../transport/index.js";

import { DrainingError } from "./drain.js";
import type { Connection, Instance, Opening } from "./instance.js";
import { encodeControl, encodeMessage, encodeRetry, type Ready } from "./wire.js";

/** What ADR-0004 tells the client core to wait before reconnecting on its own, in milliseconds. */
const RETRY_MS = 3000;

/**
 * What the `503` of a connect during a Transport outage tells whoever can read it, in seconds.
 * A browser `EventSource` is not one of them — it sees no header of a failed connect, and the
 * client core backs off on its own schedule (ADR-0004) — so this is for the proxies and load
 * balancers in between, which is part of why a `503` beats a stream that breaks after its
 * headers.
 */
const RETRY_AFTER_SECONDS = 5;

/**
 * The two reasons this Instance answers a connect with "not now", as one response.
 *
 * They are one function rather than two `new Response`s so that they cannot drift: whatever is
 * in front of this App — a load balancer taking the Instance out of rotation, a proxy backing
 * off — reads the same status and the same header whether the log is unreachable or the process
 * is on its way out, which is the whole point of answering a status rather than breaking a
 * stream after its headers (ADR-0004, ADR-0011).
 */
function notNow(reason: string): Response {
  return new Response(reason, {
    status: 503,
    headers: { "Retry-After": String(RETRY_AFTER_SECONDS) },
  });
}

const TRANSPORT_AWAY = "This Instance cannot reach its Transport right now. Try again.";
const DRAINING = "This Instance is shutting down and is not taking new Connections. Try again.";

/**
 * How many bytes of this Connection may sit written but unread before the Instance ends it.
 *
 * A client that reads slower than its Channels are published to — a phone on a bad link, a
 * background tab a proxy is dribbling to — otherwise accumulates on the Instance for as long as
 * the Connection lasts, and the max lifetime bounds that window but never the buffer. Past the
 * mark, the Connection is ended the one way a Connection is ended: `reconnect`, and the client
 * comes back with its Cursor. Nothing is dropped and nothing is lost — the Messages it had not
 * read are replayed to it — so what this costs a slow client is a round trip per megabyte, and
 * what it buys the Instance is a bound.
 *
 * The caveat, which is the honest one: this bounds what is left unread **in this stream**. If
 * whatever consumes the response buffers ahead of the socket, those bytes are not ours to see —
 * and no bound is observable from here at all.
 */
const MAX_UNREAD_BYTES = 1024 * 1024;

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
     * A draining Instance answers here, before the App's own code is asked anything: this
     * process is going away, and opening a Connection it is about to end would strand the client
     * for a second cut inside the orchestrator's grace window (ADR-0011). Sending it away with
     * the status a load balancer already reads is what moves it to a surviving Instance.
     */
    if (instance.draining) return notNow(DRAINING);

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

    /**
     * The Connection is opened **before** the `Response` exists, and that is what makes the one
     * failure left answerable: a Transport that cannot be reached rejects here, where a status is
     * still free to be chosen. Inside a `200` body it would be a stream that broke after its
     * headers, which the client would retry as a dead pipe rather than read as an Instance
     * saying "not now" (ADR-0004).
     */
    try {
      return new Response(await streamFor(instance, request, decided, cursorOf(request, url)), {
        headers: HEADERS,
      });
    } catch (error) {
      /**
       * The Drain started while this request was inside the Instance, waiting on the log: the
       * Connection was refused where it would have been registered, and this is the same answer
       * the check above would have given it a moment earlier.
       */
      if (error instanceof DrainingError) return notNow(DRAINING);
      if (!(error instanceof TransportError)) throw error;

      return notNow(TRANSPORT_AWAY);
    }
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
  /**
   * An empty Key is no Key. It is what a `key` reading a missing session header returns without
   * meaning to, and a Connection holding one could never be Kicked — `sse.kick({ key: "" })`
   * names nothing and is refused there (ADR-0003). Folding it into `undefined` here is what
   * keeps the two ends of that agreeing.
   */
  const key = instance.key?.(ctx as never) || undefined;

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

/**
 * One Connection, opened and then written: the Instance is asked for it here, and what comes
 * back is the stream that carries it.
 *
 * Opening it before the stream — rather than inside the stream's own `start` — is what lets a
 * Transport that cannot be reached be a status rather than a broken body. Everything the
 * Connection may be told in the window that opens with it (a `reset` from a gap on the live
 * feed, an ending from a Kick or a Drain) waits until the stream has written `ready`, because
 * `ready` is the first chunk of every Connection whatever else is going on (ADR-0004).
 */
async function streamFor(
  instance: Instance,
  request: Request,
  { allowed, refused, key }: Decision,
  after: string | undefined,
): Promise<ReadableStream<Uint8Array>> {
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let heartbeats: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let overflowed = false;
  /**
   * The Connection as the Instance holds it, from the moment it is registered — which is before
   * `open` resolves. Everything that can end a Connection has to work either side of that line,
   * so this is a value the teardown reads rather than one it closes over.
   */
  let opening: Opening | undefined = undefined;
  /** It was ended before its stream existed, and the stream's first act is to say so. */
  let ending = false;

  const connection: Connection = {
    channels: allowed,
    key,
    deliver: (entry) => write(encodeMessage(entry)),
    reset: () => write(encodeControl("reset")),
    caughtUp: () => write(encodeControl("caught-up")),
    /**
     * Ending a Connection is a no-op the second time, and a no-op on one whose client has already
     * gone. Before its stream exists there is nowhere to write `reconnect` to, so the ending is
     * remembered and the stream's own opening carries it out: this client is told where it stands
     * (`ready`) and then to come back (`reconnect`), which is the whole of what it is owed.
     */
    reconnect: () => {
      if (closed) return;
      if (controller === undefined) {
        ending = true;

        return;
      }

      write(encodeControl("reconnect"));
      dispose(true);
    },
  };

  opening = await instance.open(connection, { after });
  const { cursor, start: replay } = opening;

  /**
   * A Connection is in the Instance's table before `open` resolves, so a Kick or a Drain walking
   * that table reaches it while this handler is still awaiting the log. That is why the two
   * functions below are declarations — hoisted to where the Connection's own methods, written
   * above them, can call them — and why neither assumes there is a stream yet.
   */
  function write(bytes: Uint8Array): void {
    if (closed || controller === undefined) return;

    controller.enqueue(bytes);

    /**
     * With a byte-length queuing strategy on this stream, `desiredSize` is what is left of the
     * mark, so a value at or below zero is a client that is behind by more than the Instance is
     * willing to hold. The flag is what keeps the `reconnect` this triggers — a write of its own,
     * onto the same full queue — from triggering it again.
     */
    if (overflowed || (controller.desiredSize ?? 1) > 0) return;
    overflowed = true;
    connection.reconnect();
  }

  /**
   * The one teardown, whichever way the Connection ended. `endStream` is false when the stream
   * was cancelled under us — there is nothing left to close, and closing it would throw.
   *
   * Every timer this Connection armed is cleared here, and here only: a heartbeat still firing
   * at a stream nobody reads is a leak that outlives the client by the length of the process.
   */
  function dispose(endStream: boolean): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeats);
    clearTimeout(lifetime);
    request.signal.removeEventListener("abort", abort);
    opening?.close();
    if (endStream) controller?.close();
  }

  function abort(): void {
    dispose(true);
  }

  /**
   * The client may have gone while the Instance was opening the Connection: Next aborts the
   * request as soon as the response's socket closes, and that can happen before this stream is
   * ever pulled from. The Connection is released here, and the stream closes on its first breath
   * rather than being held open for a socket nobody is on.
   */
  if (request.signal.aborted) dispose(true);
  else request.signal.addEventListener("abort", abort);

  return new ReadableStream<Uint8Array>(
    {
      async start(streamController) {
        if (closed) {
          streamController.close();

          return;
        }
        controller = streamController;

        /**
         * The opening sequence, in the order ADR-0004 fixes it: `ready` as the first chunk of the
         * stream whatever the log is doing — carrying the Channels Authorize refused, so a page
         * hears about a refusal in the same breath as the Connection opening — then the retry,
         * then anything this Connection was told while it was opening, then whatever `start`
         * produces: a `reset`, the replay, `caught-up`.
         */
        const heartbeat = instance.heartbeat;
        write(encodeControl("ready", { cursor, refused, heartbeat } satisfies Ready));
        write(encodeRetry(RETRY_MS));

        /**
         * It was ended while it was opening, so this stream exists only to say so. No timer is
         * armed and no replay is run: what this client missed is the next Connection's to carry,
         * and it comes back with the Cursor `ready` has just given it — which is what a Cursor is
         * for.
         */
        if (ending) {
          connection.reconnect();

          return;
        }

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
         * the same three bytes on the wire and the same teardown behind them.
         */
        const maxLifetime = instance.maxLifetime;
        if (maxLifetime > 0) {
          lifetime = setTimeout(() => {
            connection.reconnect();
          }, spread(maxLifetime));
          lifetime.unref?.();
        }

        await replay();
      },

      /**
       * The client went away: Next aborts the pipe on the response's `close`, which cancels this
       * stream, and aborts `request.signal` for good measure. Either path leads here, and the
       * Connection leaves the table exactly once.
       */
      cancel() {
        dispose(false);
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: MAX_UNREAD_BYTES }),
  );
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
