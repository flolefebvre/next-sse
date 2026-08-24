"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";

import { appendMessage, appendNotice, appendNotification, type Message } from "@/lib/messages";
import { ROLE_COOKIE, sessionFrom, type Role } from "@/lib/session";
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
 * One Message for one reader, on the Channel only that reader may read.
 *
 * The Channel a Publish addresses is built from the session, not from anything the caller sent:
 * the same rule the Registry's `authorize` states from the reading side, kept from the writing
 * side. A real App notifies somebody *else* from wherever the event happens — an order shipped,
 * a mention posted — and the only line that changes is where the user id comes from.
 */
export async function notifyMe(text: string): Promise<Message> {
  const session = sessionFrom((await headers()).get("cookie"));
  const notification = appendNotification(session.userId, text);
  await sse.notifications({ userId: session.userId }).arrived(notification);

  return notification;
}

/**
 * What this reader may do, for as long as this demo lasts: one cookie, and a re-render.
 *
 * A real App signs in here. The re-render is only half of what a change of session owes: it
 * gives the page new server-rendered data, and it does nothing at all to the Connection that is
 * already open — that one is still carrying the Channels the *old* session was authorized for.
 * `kickMe` below is the other half.
 *
 * The Key is deliberately left alone. What changed about this reader is their role, not who
 * they are, and a Kick addresses a Connection by the Key it *opened* with: rotate the Key here
 * and the open Connection is left addressable only by a name nothing will ever use again — a
 * revocation that writes an Entry and matches nobody. An App whose sign-in really does change
 * identity has to Kick the Key that is being left behind, before the new one is anywhere.
 */
export async function switchRole(role: Role): Promise<void> {
  const jar = await cookies();
  jar.set(ROLE_COOKIE, role);
  revalidatePath("/");
}

/**
 * End this reader's own Connections, so the next one is Authorized against the session it has
 * now: the admin panel flips to `refused` where it was live, without a reload and without
 * losing a Message on the room, which goes on streaming across the cut.
 *
 * It is a call of its own, and that is the whole lesson. A Kick issued by the very request that
 * changed the session races that request's own response: the `reconnect` travels on the open
 * stream, the new cookie travels in the response, and nothing orders the two — a client that
 * reopens first is re-Authorized against the session it was just taken out of. When the session
 * about to be re-Authorized is the one you just changed, Kick from the next request, not from
 * the same one.
 *
 * The Key it reads is the one the open Connection carries, because `switchRole` did not touch
 * it. That is the other half of the same rule: a Kick can only ever end a Connection whose Key
 * it names.
 */
export async function kickMe(): Promise<void> {
  const session = sessionFrom((await headers()).get("cookie"));
  await sse.kick({ key: session.userId });
}
