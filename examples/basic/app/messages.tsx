"use client";

import { upsertBy, type Snapshot } from "@flefebvre/next-sse/client";

import type { Message } from "@/lib/messages";
import { channels, useChannelState } from "@/lib/sse.client";

import { send } from "./actions";

/**
 * The Channel's Messages, live, starting from what the server rendered.
 *
 * The hook owns the list: seeded from the Snapshot, advanced by one reducer per event, and
 * restarted whenever a new Snapshot arrives — which is what a Reset costs this component, since
 * the provider's default refreshes the route and the refreshed server component mints one.
 * `upsertBy('id')` is the whole of the duplicate handling: the overlap between the Snapshot and
 * the replay, and the echo of what this page sent, are the same Message twice.
 *
 * There is no `EventSource` here, no route path and no Channel name: `channels.chat({ roomId })`
 * is a Handle, and the hook resolves it against the data the provider put in the tree.
 */
export function Messages({ roomId, snapshot }: { roomId: string; snapshot: Snapshot<Message[]> }) {
  const { state, status, pending, inFlight, act } = useChannelState(
    channels.chat({ roomId }),
    snapshot,
    { message: upsertBy("id") },
  );

  /**
   * One optimistic round: the row shows while the action runs, the Message the action returns
   * is applied before the transition ends, and the same Message arriving over the stream
   * changes nothing. The optimistic payload has the event's own shape — there is no second type
   * for "not sent yet".
   */
  const publish = (formData: FormData) => {
    const text = String(formData.get("text") ?? "");
    if (text === "") return;

    act("message", { id: `pending-${Date.now()}`, text }, () => send(roomId, text));
  };

  return (
    <>
      <p data-testid="status">{status}</p>
      <ul data-testid="messages">
        {state.map((message) => (
          <li key={message.id}>{message.text}</li>
        ))}
      </ul>
      <ul data-testid="pending">
        {pending.message.map((message) => (
          <li key={message.id}>{message.text}</li>
        ))}
      </ul>
      <form action={publish}>
        <input name="text" aria-label="Message" autoComplete="off" />
        <button type="submit" disabled={inFlight}>
          Publish
        </button>
      </form>
    </>
  );
}
