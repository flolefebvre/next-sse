"use client";

import { upsertBy, type Snapshot } from "@flefebvre/next-sse/client";
import { useState } from "react";

import type { Message } from "@/lib/messages";
import { channels, useChannelState } from "@/lib/sse.client";

import { latestAnnouncements } from "./actions";

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
  /**
   * The Reset override, and the whole of what one is: a Snapshot this component owns.
   *
   * A Reset says the Cursor this Channel was resuming from is unusable — too old for what the
   * log still keeps — so the data on screen may have holes in it and the App has to read again.
   * The provider's default answer is `router.refresh()`, which re-runs the whole page; this
   * panel does the smaller thing instead and refetches its own list. Handing the hook the new
   * Snapshot is what closes the loop: it re-seeds the state and reopens the Channel from the
   * position that read was taken at, so nothing published in between is missed.
   *
   * A page whose Reset costs a refresh needs none of this. Write one where the refresh is too
   * much — a heavy route, a form the reader is in the middle of — or where this Channel's data
   * is the only thing worth reading again.
   *
   * The second piece of state is the server's: whenever a new render does arrive — after a Kick,
   * after a navigation — its Snapshot is the newer one and it wins over whatever this component
   * fetched for itself.
   */
  const [seed, setSeed] = useState(snapshot);
  const [rendered, setRendered] = useState(snapshot);
  if (rendered !== snapshot) {
    setRendered(snapshot);
    setSeed(snapshot);
  }

  const { state, status } = useChannelState(
    channels.announcements(),
    seed,
    { posted: upsertBy("id") },
    { onReset: () => void latestAnnouncements().then(setSeed) },
  );

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
