import { sessionFrom } from "@/lib/session";
import { sse } from "@/lib/sse";

/**
 * Kick from a Route Handler: an admin tool ends somebody's Connections, and every Instance of
 * this App acts on it — the one holding the stream need not be the one that took the call.
 *
 * `sse.kick({ key })` writes one control Entry and resolves there. It does not wait for the
 * Connections to close, and there is nothing to wait for: the Instances that close them are on
 * the far side of the log. What the caller is promised is that the revocation is in the log.
 *
 * The guard is this handler's own, exactly as `announce` guards its Publish: Authorize decides
 * who may *read* a Channel and is never asked about anything else, so a route that acts on
 * somebody else's Connections checks the session itself.
 */
export async function POST(request: Request): Promise<Response> {
  const session = sessionFrom(request.headers.get("cookie"));
  if (session.role !== "admin") {
    return Response.json({ error: "Only an admin may kick." }, { status: 403 });
  }

  const { userId } = (await request.json()) as { userId?: string };
  if (typeof userId !== "string" || userId === "") {
    return Response.json({ error: "userId is required" }, { status: 400 });
  }

  await sse.kick({ key: userId });

  return Response.json({ kicked: true });
}
