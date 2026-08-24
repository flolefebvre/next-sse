# Server component + live takeover

The page renders on the server with real data, and the stream picks up exactly where that read
left off. No loading state, no flash of an empty list, and nothing lost in the window between the
two.

Example app:
[`app/page.tsx`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/page.tsx)
into
[`app/messages.tsx`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/messages.tsx).

## The four lines

```tsx
// app/page.tsx
import { cookies } from "next/headers";

import { listMessages } from "@/lib/messages";
import { sse } from "@/lib/sse";

import { Messages } from "./messages";

export default async function Page() {
  await cookies(); // this render must happen per request — see below
  const messages = await sse.snapshot(() => listMessages("42"));

  return <Messages roomId="42" snapshot={messages} />;
}
```

```tsx
// app/messages.tsx
"use client";

import { upsertBy, type Snapshot } from "@flefebvre/next-sse/client";

import { channels, useChannelState } from "@/lib/sse.client";

type Message = { id: string; text: string };

export function Messages({ roomId, snapshot }: { roomId: string; snapshot: Snapshot<Message[]> }) {
  const { state, status } = useChannelState(channels.chat({ roomId }), snapshot, {
    message: upsertBy("id"),
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

## Why it is gap-free

`sse.snapshot(read)` takes the Cursor **before** running the read. So the order of events is:

1. the log's position is noted;
2. the data is read;
3. the HTML is streamed, hydrated, and the Connection opens **from that position**;
4. everything published between 1 and 3 is replayed to this client, once.

Taking the position after the read would lose whatever landed in between. Nothing an App writes
can get that order wrong, because the App does not write it — and the word "cursor" never appears
in the App's code.

The overlap is the reducer's job: a Message that is both in the Snapshot and in the replay arrives
twice, and `upsertBy("id")` makes it one row.

## One Cursor per render

`sse.cursor()` is memoised per request, so a page with four Snapshots on it has **one** position
and costs **one** reconnect — not four.

```tsx
const messages = await sse.snapshot(() => listMessages(roomId));
const notices = await sse.snapshot(() => listNotices());
const announcements = await sse.snapshot(() => listAnnouncements());
```

## Read per request, or the Snapshot goes stale

With `cacheComponents` on, a Server Component that touches no request data is prerendered at
build time — and a Snapshot baked into HTML resumes from a position that may be days old, which
the client answers with a Reset on first connect.

Touch request data in any component that mints a Snapshot: `cookies()`, `headers()`, or
`connection()`. Most such components need the session anyway.

Read cookies through `cookies()` rather than `headers().get("cookie")`. A server action that
writes a cookie and then revalidates its own path re-renders this component **inside that same
request**, whose `Cookie` header is still the one the browser sent: read from the header, the page
answers with the session from before the click.

## A page with nothing to read

The handoff still applies — subscribe from a position rather than live-only:

```tsx
const seed = await sse.snapshot(() => null);
```

## Re-seeding

A new Snapshot prop **restarts** the hook's state. That is what closes the Reset loop: the
provider refreshes the route, the Server Component reads again at a fresh position, and the hook
starts over from it. It is also what a navigation gives for free.

If a component wants to fetch its own replacement instead of refreshing the route, see
[reset override](reset-override.md).

## Notes

- Suspense boundaries are ordinary: put the read in a component under `<Suspense>` and the
  Snapshot is minted when that component renders.
- The Snapshot is a serialisable prop and nothing more — it crosses the RSC boundary like any
  other. It is opaque by type, so it can only be spent by a hook.
- Guard the server render as well as the stream. Authorize decides what the Connection may read;
  it says nothing about what the page put in the HTML.
