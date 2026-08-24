"use client";

import { upsertBy, type Snapshot } from "@flefebvre/next-sse/client";

import type { Message } from "@/lib/messages";
import { channels, useChannelState } from "@/lib/sse.client";

import { announce } from "./actions";

/**
 * The admin-only Channel, subscribed to by every reader alike — and refused to most of them.
 *
 * Nothing here asks who is reading: the component subscribes, and the server decides. A guest's
 * Connection carries `chat` exactly as before and reports this Channel as `refused`, which is
 * the whole shape of per-Channel refusal (ADR-0003). The status is the only thing this
 * component does about it; a real page would hide the panel or explain itself.
 */
export function Notices({ snapshot }: { snapshot: Snapshot<Message[]> }) {
  const { state, status, act, inFlight } = useChannelState(channels.admin(), snapshot, {
    notice: upsertBy("id"),
  });

  const publish = (formData: FormData) => {
    const text = String(formData.get("notice") ?? "");
    if (text === "") return;

    act("notice", { id: `pending-${Date.now()}`, text }, () => announce(text));
  };

  return (
    <section>
      <h2>Admin notices</h2>
      <p data-testid="notices-status">{status}</p>
      <ul data-testid="notices">
        {state.map((notice) => (
          <li key={notice.id}>{notice.text}</li>
        ))}
      </ul>
      <form action={publish}>
        <input name="notice" aria-label="Notice" autoComplete="off" />
        <button type="submit" disabled={inFlight || status === "refused"}>
          Announce
        </button>
      </form>
    </section>
  );
}
