"use client";

import { upsertBy, type Snapshot } from "@flefebvre/next-sse/client";

import type { Message } from "@/lib/messages";
import { channels, useChannelState } from "@/lib/sse.client";

import { notifyMe } from "./actions";

/**
 * One reader's own notifications, live: the per-user pattern, which is a Channel name with the
 * reader in it and an Authorize that checks it.
 *
 * The user id comes down from the server render, and it is the same id the session gave
 * `authorize` — a page that passed anything else would be asking for a Channel it will be
 * refused. There is no filtering on this side: what reaches a Connection is what the server let
 * it subscribe to, so a component rendering somebody's notifications renders all of them.
 *
 * Nothing is optimistic here, and that is deliberate: the row appears when the Message comes
 * back down the stream, which is what most notifications are — something happening elsewhere,
 * arriving here. The room next door shows the other half, where the sender is this page.
 */
export function Notifications({
  userId,
  snapshot,
}: {
  userId: string;
  snapshot: Snapshot<Message[]>;
}) {
  const { state, status } = useChannelState(channels.notifications({ userId }), snapshot, {
    arrived: upsertBy("id"),
  });

  const notify = (formData: FormData) => {
    const text = String(formData.get("notification") ?? "");
    if (text !== "") void notifyMe(text);
  };

  return (
    <section>
      <h2>Your notifications</h2>
      <p data-testid="notifications-status">{status}</p>
      <ul data-testid="notifications">
        {state.map((notification) => (
          <li key={notification.id}>{notification.text}</li>
        ))}
      </ul>
      <form action={notify}>
        <input name="notification" aria-label="Notification" autoComplete="off" />
        <button type="submit">Notify me</button>
      </form>
    </section>
  );
}
