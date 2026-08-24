import { appendMessage } from "@/lib/messages";
import { ROOM_ID, sse } from "@/lib/sse";

/**
 * Publish from a Route Handler: anything that can reach this App over HTTP — a webhook from a
 * payment provider, a cron runner, an admin tool — writes and Publishes through the same bound
 * Handle the page's server action uses.
 */
export async function POST(request: Request): Promise<Response> {
  const { text } = (await request.json()) as { text?: string };
  if (typeof text !== "string" || text === "") {
    return Response.json({ error: "text is required" }, { status: 400 });
  }

  await sse.chat({ roomId: ROOM_ID }).message(appendMessage(ROOM_ID, text));

  return Response.json({ published: true });
}
