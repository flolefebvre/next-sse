"use server";

import { appendMessage, type Message } from "@/lib/messages";
import { sse } from "@/lib/sse";

/**
 * Write, then Publish, then hand the Message back — the order every send follows.
 *
 * The return value is what makes the sender's own list move before its Message comes back down
 * the stream: `act` applies it through the same reducer the Channel's Messages go through, and
 * the echo that arrives a moment later is absorbed by `upsertBy('id')`. Nothing here is
 * special-cased for the sender, and no page is refetched to show what was just sent.
 */
export async function send(roomId: string, text: string): Promise<Message> {
  const message = appendMessage(roomId, text);
  await sse.chat({ roomId }).message(message);

  return message;
}
