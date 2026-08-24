# Optimistic sends

The sender is the page. The row appears immediately, the action runs, and the Message coming back
down the stream changes nothing.

Example app: `act(...)` in
[`app/messages.tsx`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/messages.tsx),
`send` in
[`app/actions.ts`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/actions.ts).

## The action: write, publish, return

```ts
// app/actions.ts
"use server";

import { appendMessage, type Message } from "@/lib/messages";
import { sse } from "@/lib/sse";

export async function send(roomId: string, input: string): Promise<Message> {
  const text = input.trim();
  if (text === "") throw new Error("A Message needs something to say.");

  const message = appendMessage(roomId, text);
  await sse.chat({ roomId }).message(message);

  return message;
}
```

Returning the Message is what makes the sender's own list settle before the echo arrives. Reject
here whatever the event's schema would reject: the schema runs on the Publish, which is after the
write.

## The component: one call

```tsx
// app/messages.tsx
"use client";

import { upsertBy, type Snapshot } from "@flefebvre/next-sse/client";

import { channels, useChannelState } from "@/lib/sse.client";

import { send } from "./actions";

type Message = { id: string; text: string };

export function Messages({ roomId, snapshot }: { roomId: string; snapshot: Snapshot<Message[]> }) {
  const { state, pending, inFlight, act } = useChannelState(channels.chat({ roomId }), snapshot, {
    message: upsertBy("id"),
  });

  const publish = (formData: FormData) => {
    const text = String(formData.get("text") ?? "");
    if (text === "") return;

    act("message", { id: `pending-${Date.now()}`, text }, () => send(roomId, text));
  };

  return (
    <>
      <ul>
        {state.map((message) => (
          <li key={message.id}>{message.text}</li>
        ))}
      </ul>
      <ul>
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
```

## What `act` does

`act(event, optimistic, action)` folds three things together:

1. shows `optimistic` in `pending[event]` for exactly as long as the transition lasts;
2. awaits `action()`;
3. applies what it returned through the event's reducer, **before** the transition ends.

So the row never blinks — the optimistic entry disappears in the same commit the real one appears
in — and there is no bookkeeping to undo when the action throws: the optimistic payload simply
goes away with the transition.

The optimistic payload has the event's **own wire shape**. There is no second type for "not sent
yet", which is why `pending.message` renders with the same code as `state`.

Pass `null` to send without an optimistic payload: `act("message", null, () => send(roomId, text))`.

## Three duplicates, one reducer

The same Message can reach this component three times: applied from the action's result, replayed
after a reconnect, and delivered live as its own echo. `upsertBy("id")` makes all three one row —
which is why the id must come from the server, not from the optimistic payload.

## Simpler variants

- **Echo only** — do nothing on submit but call the action; the row appears when the Message
  arrives. Correct, and one round trip slower on screen.
- **`apply` without the optimistic step** — when there is nothing worth showing while the action
  runs:

  ```tsx
  const { apply } = useChannelState(...);
  const message = await send(roomId, text);
  apply("message", message);
  ```

## Notes

- `inFlight` is true while any `act` on this hook is running. Disable the submit with it, not with
  state of your own.
- Give the optimistic payload an id nothing else can collide with (`pending-${Date.now()}` is
  enough); it only ever lives in `pending`.
- An action that throws surfaces as a rejected transition. Catch it in the action's caller if the
  page should say something.
