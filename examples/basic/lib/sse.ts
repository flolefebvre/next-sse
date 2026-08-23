import { initSSE } from "@flefebvre/next-sse/server";

const { channel, createSSE } = initSSE();

/**
 * The App's Registry: every Channel it has, declared once, in a server-only module. Both the
 * route file and every place that Publishes import this one value.
 *
 * `events` lists the events the Channel carries; each one becomes a method on a Handle
 * (`chat({ roomId }).message(payload)`). The event's schema is what will sit next to its name
 * once schemas ship, and Authorize will sit beside `events`.
 */
export const sse = createSSE({
  chat: channel({
    pattern: "chat:{roomId}",
    events: { message: undefined },
  }),
});

/** The one room this example talks in. A real App takes it from the URL or the session. */
export const ROOM_ID = "42";
