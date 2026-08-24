# Broadcast

One Channel, no params, everybody on it. Deploy banners, incident notices, a global counter.

Example app:
[`app/announcements.tsx`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/announcements.tsx),
`announcements` in
[`lib/sse.ts`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/lib/sse.ts).

## Declare it

```ts
// lib/sse.ts
export const sse = createSSE({
  announcements: channel({
    pattern: "announcements",
    events: { posted: z.object({ id: z.string(), text: z.string().min(1) }) },
    authorize: () => true,
  }),
});
```

The plainest Channel an App can declare, and the one thing worth saying about it is that
`authorize` is still written out. A Channel every Connection may read says so; the decision is
never absent, and a reader of this Registry can tell public from forgotten.

A Handle for a pattern with no params takes no argument: `sse.announcements()`.

## Publish

```ts
await sse.announcements().posted({ id: crypto.randomUUID(), text: "we shipped" });
```

A broadcast usually comes from something that is not a request — a deploy hook, a cron, an
incident bot — which is a worker: [publishing from a worker](publish-from-a-worker.md).

## Subscribe

```tsx
// app/announcements.tsx
"use client";

import { upsertBy, type Snapshot } from "@flefebvre/next-sse/client";

import { channels, useChannelState } from "@/lib/sse.client";

type Announcement = { id: string; text: string };

export function Announcements({ snapshot }: { snapshot: Snapshot<Announcement[]> }) {
  const { state } = useChannelState(channels.announcements(), snapshot, {
    posted: upsertBy("id"),
  });

  return (
    <ul>
      {state.map((announcement) => (
        <li key={announcement.id}>{announcement.text}</li>
      ))}
    </ul>
  );
}
```

Every reader is on the same Channel, so this component is identical for every session, and the
Messages are the same Messages. Nothing else about it differs from a per-entity Channel: a
broadcast is a Channel, not a mechanism of its own.

## A banner with no list to keep

When the update is not a collection, the low-level hook is enough:

```tsx
"use client";

import { useState } from "react";

import { channels, useChannel } from "@/lib/sse.client";

export function Banner() {
  const [notice, setNotice] = useState<string | null>(null);
  useChannel(channels.announcements(), { posted: (payload) => setNotice(payload.text) });

  return notice === null ? null : <aside role="status">{notice}</aside>;
}
```

With no Snapshot the hook is **live-only**: it hears nothing that happened before it mounted, and
nothing of a replay until the Connection has caught up. That is what you want for a banner, and
not what you want for a list.

## Notes

- Every Instance delivers a broadcast to every Connection it holds. One Publish, one log Entry,
  however many readers.
- Fan-out cost is per Connection, not per Channel: a broadcast to 5 000 open pages is 5 000
  writes spread over the Instances holding them.
- A broadcast that must survive a reader being away is a list with a Snapshot, not a banner —
  retention bounds how far back the replay reaches ([deployment.md](../deployment.md)).
