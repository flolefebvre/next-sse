import { sse } from "@/lib/sse";

/**
 * The whole SSE endpoint: the handler the library built from the Registry, re-exported. Every
 * Connection of this App is one `GET` here, with the Channels it subscribes to on the query.
 */
export const { GET } = sse.handlers;
