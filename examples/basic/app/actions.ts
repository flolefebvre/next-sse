"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";

import { appendMessage, appendNotice, type Message } from "@/lib/messages";
import { ROLE_COOKIE, sessionFrom, USER_COOKIE, type Role } from "@/lib/session";
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

/**
 * The same round on the admin Channel — with the write guarded on its own.
 *
 * Authorize decides who may *read* a Channel; it is never asked about a Publish, and a server
 * action is reachable by anyone who can reach the App. So this one checks the session again,
 * here, where the write happens. The two guards read the same session and are deliberately not
 * the same guard.
 */
export async function announce(text: string): Promise<Message> {
  const session = sessionFrom((await headers()).get("cookie"));
  if (session.role !== "admin") throw new Error("Only an admin may announce.");

  const notice = appendNotice(text);
  await sse.admin().notice(notice);

  return notice;
}

/**
 * Who this reader is, for as long as this demo lasts: two cookies, and a re-render.
 *
 * A real App signs in here. What matters for the library is what happens next: the page is
 * rendered again for the new session, the hooks reopen their Connection, and Authorize decides
 * afresh — which is why an admin sees the notices go live without a reload, and a guest sees
 * that Channel refused.
 */
export async function switchRole(role: Role): Promise<void> {
  const jar = await cookies();
  jar.set(ROLE_COOKIE, role);
  jar.set(USER_COOKIE, role === "admin" ? "ada" : "sam");
  revalidatePath("/");
}
