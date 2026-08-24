import { appendMessage } from "@/lib/messages";
import { ROOM_ID, sse } from "@/lib/sse";

/**
 * Publish from a Route Handler: anything that can reach this App over HTTP — a webhook from a
 * payment provider, a cron runner, an admin tool — writes and Publishes through the same bound
 * Handle the page's server action uses.
 *
 * The room is the caller's to name, defaulting to the one the page shows. That is what a
 * Channel with a pattern is for: `chat:{roomId}` is a family of Channels, and a Handle is one
 * of them with its params filled in — the same call, addressed differently. Nothing else in the
 * demo changes with the room: the store keys by it, and `authorize` says the same thing about
 * every one of them.
 */
export async function POST(request: Request): Promise<Response> {
  const { text, roomId = ROOM_ID } = (await request.json()) as {
    text?: string;
    roomId?: string;
  };
  if (typeof text !== "string" || text === "") {
    return Response.json({ error: "text is required" }, { status: 400 });
  }
  if (typeof roomId !== "string" || roomId === "") {
    return Response.json({ error: "roomId must be a room" }, { status: 400 });
  }

  await sse.chat({ roomId }).message(appendMessage(roomId, text));

  return Response.json({ published: true });
}
