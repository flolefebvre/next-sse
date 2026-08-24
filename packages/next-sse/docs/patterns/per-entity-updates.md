# Per-entity updates

A Channel per thing: a room, an order, a document, a build. The pattern carries the entity's id,
and a Handle is one member of the family.

Example app:
[`app/messages.tsx`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/messages.tsx),
`chat` in
[`lib/sse.ts`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/lib/sse.ts),
[`app/api/webhook/route.ts`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/api/webhook/route.ts).

## Declare it

```ts
// lib/sse.ts
export const sse = createSSE({
  chat: channel({
    pattern: "chat:{roomId}",
    events: {
      message: z.object({ id: z.string(), text: z.string().min(1) }),
      deleted: z.object({ id: z.string() }),
    },
    authorize: (params, session) => session.rooms.includes(params.roomId),
  }),
});
```

A Channel carries as many events as the entity has kinds of change. They travel together, in
order, on one subscription.

`authorize` is where membership is decided, once per connect and per reconnect. It may read the
session, the database, anything the server can reach — this module is server-only.

## Publish from anywhere server-side

The same bound Handle works from a server action, a Route Handler, a cron job, an RSC:

```ts
// app/api/webhook/route.ts
import { appendMessage } from "@/lib/messages";
import { sse } from "@/lib/sse";

export async function POST(request: Request): Promise<Response> {
  const { text, roomId } = (await request.json()) as { text?: string; roomId?: string };
  if (typeof text !== "string" || text === "") {
    return Response.json({ error: "text is required" }, { status: 400 });
  }
  if (typeof roomId !== "string" || roomId === "" || roomId.includes(":")) {
    return Response.json({ error: 'roomId must be a room name without ":"' }, { status: 400 });
  }

  await sse.chat({ roomId }).message(appendMessage(roomId, text));

  return Response.json({ published: true });
}
```

Two guards worth copying:

- **`:` is refused before the write.** It is the one character a param may not carry, so the
  Handle would throw on it — after the row had been stored. Whatever lets a caller name a Channel
  validates the name first.
- **Authorize does not guard this.** It decides who may *read* a Channel and is never asked about
  a Publish. A route that anyone can reach checks the session itself.

## Subscribe

```tsx
// app/messages.tsx
"use client";

import { upsertBy, type Snapshot } from "@flefebvre/next-sse/client";

import { channels, useChannelState } from "@/lib/sse.client";

type Message = { id: string; text: string };

export function Messages({ roomId, snapshot }: { roomId: string; snapshot: Snapshot<Message[]> }) {
  const { state, status } = useChannelState(channels.chat({ roomId }), snapshot, {
    message: upsertBy("id"),
    deleted: (messages, { id }) => messages.filter((message) => message.id !== id),
  });

  return (
    <>
      <p>{status}</p>
      <ul>
        {state.map((message) => (
          <li key={message.id}>{message.text}</li>
        ))}
      </ul>
    </>
  );
}
```

One reducer per event. `upsertBy("id")` absorbs every duplicate the library can produce; the
`deleted` reducer shows that a reducer is just a function over the state.

## Navigating between entities

A component whose `roomId` prop changes resubscribes: the old Channel goes, the new one comes, on
one reconnect. Give it a fresh Snapshot at the same time — from the Server Component that rendered
the new room — and the new list is seeded and gap-free like the first one was.

```tsx
<Messages key={roomId} roomId={roomId} snapshot={snapshot} />
```

The `key` is worth it when the two rooms' lists must not blend during the transition.

## Notes

- Several entities on one page — a list of orders, each live — is several hooks, and still **one**
  Connection: the client coalesces the Channel set.
- Channel names are not secrets. Authorize is what protects an entity, not an unguessable id.
- A page whose entity set changes on every keystroke will reconnect on every keystroke. Debounce
  the prop, not the hook.
