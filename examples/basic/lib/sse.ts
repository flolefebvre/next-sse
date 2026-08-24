import { initSSE } from "@flefebvre/next-sse/server";
import { z } from "zod";

const { channel, createSSE } = initSSE();

/**
 * The App's Registry: every Channel it has, declared once, in a server-only module. Both the
 * route file and every place that Publishes import this one value.
 *
 * `events` lists the events the Channel carries, each with the schema its payload is checked
 * against; each one becomes a method on a Handle (`chat({ roomId }).message(payload)`). Any
 * Standard Schema does — this App happens to use zod 4, and the library depends on none of
 * them. Authorize will sit beside `events`.
 */
export const sse = createSSE({
  chat: channel({
    pattern: "chat:{roomId}",
    events: {
      message: z.object({ id: z.string(), text: z.string().trim().min(1) }),
    },
    authorize: () => true,
  }),
});

/** The one room this example talks in. A real App takes it from the URL or the session. */
export const ROOM_ID = "42";
