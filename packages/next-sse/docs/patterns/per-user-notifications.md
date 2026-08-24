# Per-user notifications

One Channel per reader, and the param is what decides who may read it.

Example app:
[`app/notifications.tsx`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/notifications.tsx),
`notifications` in
[`lib/sse.ts`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/lib/sse.ts),
`notifyMe` in
[`app/actions.ts`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/actions.ts).

## Declare it

```ts
// lib/sse.ts
import { initSSE } from "@flefebvre/next-sse/server";
import { z } from "zod";

import { sessionFrom, type Session } from "./session";

const { channel, createSSE } = initSSE({
  context: (request: Request): Session => sessionFrom(request.headers.get("cookie")),
  key: (session) => session.userId,
});

export const sse = createSSE({
  notifications: channel({
    pattern: "notifications:{userId}",
    events: { arrived: z.object({ id: z.string(), text: z.string().min(1) }) },
    authorize: (params, session) => params.userId === session.userId,
  }),
});
```

`notifications:{userId}` is a family of Channels; nothing enumerates them. `authorize` is handed
the params of the very Channel being asked for, so the rule is one line: this reader may read
their own and nobody else's.

**The lesson of the whole pattern is in that line.** A client may ask for any Channel name it
likes. An App that reads the user id off the request instead of off its own session has no
authorization at all.

## Publish to one reader

```ts
// app/actions.ts
"use server";

import { headers } from "next/headers";

import { appendNotification } from "@/lib/messages";
import { sessionFrom } from "@/lib/session";
import { sse } from "@/lib/sse";

export async function notifyMe(text: string) {
  const session = sessionFrom((await headers()).get("cookie"));
  const notification = appendNotification(session.userId, text);
  await sse.notifications({ userId: session.userId }).arrived(notification);

  return notification;
}
```

A real App notifies somebody *else*, from wherever the event happens — an order shipped, a mention
posted, a job finished — and the only line that changes is where the user id comes from. It is
never the caller's to name.

Write first, publish second: the Publish validates the payload, and a schema refusal after the
write would leave a row nobody was told about.

## Render it

```tsx
// app/page.tsx
import { cookies } from "next/headers";

import { listNotifications } from "@/lib/messages";
import { sessionFrom } from "@/lib/session";
import { sse } from "@/lib/sse";

import { Notifications } from "./notifications";

export default async function Page() {
  const session = sessionFrom((await cookies()).toString());
  const notifications = await sse.snapshot(() => listNotifications(session.userId));

  return <Notifications userId={session.userId} snapshot={notifications} />;
}
```

```tsx
// app/notifications.tsx
"use client";

import { upsertBy, type Snapshot } from "@flefebvre/next-sse/client";

import { channels, useChannelState } from "@/lib/sse.client";

type Notification = { id: string; text: string };

export function Notifications({
  userId,
  snapshot,
}: {
  userId: string;
  snapshot: Snapshot<Notification[]>;
}) {
  const { state, status } = useChannelState(channels.notifications({ userId }), snapshot, {
    arrived: upsertBy("id"),
  });

  return (
    <section>
      <p>{status}</p>
      <ul>
        {state.map((notification) => (
          <li key={notification.id}>{notification.text}</li>
        ))}
      </ul>
    </section>
  );
}
```

The user id comes down from the server render — the same id the session gave `authorize`. A page
that passed anything else would be asking for a Channel it will be refused.

There is no filtering on the client side, and there should not be: what reaches a Connection is
what the server let it subscribe to.

## Notes

- Nothing here is optimistic. Most notifications are something happening elsewhere, arriving here;
  the row appears when the Message does. For the other half, see
  [optimistic sends](optimistic-sends.md).
- If sign-in changes who this reader is, the open Connection is still carrying the old identity's
  Channels — see [kick](kick.md).
- A user with several tabs holds several Connections, all subscribed to the same Channel. Each one
  gets the Message.
