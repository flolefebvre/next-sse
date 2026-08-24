"use client";

import { upsertBy, type Snapshot } from "@flefebvre/next-sse/client";

import type { Message } from "@/lib/messages";
import { channels, useChannelState } from "@/lib/sse.client";

/**
 * The broadcast, as a page consumes one: subscribe, and render what arrives.
 *
 * Every reader is on the same Channel here — the Handle takes no params, and `authorize` said
 * yes to everyone — so this component is the same for a guest and for an admin, and the Messages
 * are the same Messages. Nothing else about it differs from the room next door: a broadcast is
 * a Channel, not a mechanism of its own.
 *
 * It is read-only because the App's broadcast is written from outside a request (see `worker/`),
 * which is what makes it the natural place to show a Reset that refetches instead of refreshing.
 */
export function Announcements({ snapshot }: { snapshot: Snapshot<Message[]> }) {
  const { state, status } = useChannelState(channels.announcements(), snapshot, {
    posted: upsertBy("id"),
  });

  return (
    <section>
      <h2>Announcements</h2>
      <p data-testid="announcements-status">{status}</p>
      <ul data-testid="announcements">
        {state.map((announcement) => (
          <li key={announcement.id}>{announcement.text}</li>
        ))}
      </ul>
    </section>
  );
}
