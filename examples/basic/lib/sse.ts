import { initSSE } from "@flefebvre/next-sse/server";
import { z } from "zod";

import { sessionFrom, type Session } from "./session";

/**
 * The App's configuration, in the one call that takes it: what this App builds from a request,
 * and what it calls the holder of a Connection.
 *
 * `context` runs once per Connection — on the first connect and on every reconnect — and what
 * it returns is what every `authorize` below is handed, typed. `key` derives the Connection's
 * Key from it: the opaque identity a Kick will address Connections by, and the only thing the
 * library knows about who holds one. An App with only public Channels writes neither.
 */
const { channel, createSSE } = initSSE({
  context: (request: Request): Session => sessionFrom(request.headers.get("cookie")),
  key: (session) => session.userId,
});

/**
 * The App's Registry: every Channel it has, declared once, in a server-only module. Both the
 * route file and every place that Publishes import this one value.
 *
 * `events` lists the events the Channel carries, each with the schema its payload is checked
 * against; each one becomes a method on a Handle (`chat({ roomId }).message(payload)`). Any
 * Standard Schema does — this App happens to use zod 4, and the library depends on none of
 * them.
 *
 * `authorize` sits beside `events`, and it is required: it is asked once per Channel when a
 * Connection opens and again on every reconnect, never per Message. `chat` is public and says
 * so out loud; `admin` is not, and a reader without the role is refused it — the Connection
 * carries on with `chat` streaming, and the refusal shows on that one hook alone.
 */
export const sse = createSSE({
  chat: channel({
    pattern: "chat:{roomId}",
    events: {
      message: z.object({ id: z.string(), text: z.string().trim().min(1) }),
    },
    authorize: () => true,
  }),
  admin: channel({
    pattern: "admin",
    events: {
      notice: z.object({ id: z.string(), text: z.string().trim().min(1) }),
    },
    authorize: (_params, session) => session.role === "admin",
  }),
});

/** The one room this example talks in. A real App takes it from the URL or the session. */
export const ROOM_ID = "42";
