# Reset override

A Reset says the position a Connection was resuming from is no longer in the log, so the data on
screen may have holes and has to be read again. The default answer is `router.refresh()`. Override
it when a full route refresh is too much.

Example app: `onReset` in
[`app/announcements.tsx`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/announcements.tsx),
`latestAnnouncements` in
[`app/actions.ts`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/actions.ts).

## The default, which most Apps keep

No code. The provider calls `router.refresh()`, the Server Components run again, each mints a
fresh Snapshot, and the new props restart the hooks that hold them. A page whose refresh is cheap
needs nothing on this page.

## Override for one component

Refetch just this component's data, and re-seed the hook with it:

```tsx
// app/announcements.tsx
"use client";

import { upsertBy, type Snapshot } from "@flefebvre/next-sse/client";
import { useState } from "react";

import { channels, useChannelState } from "@/lib/sse.client";

import { latestAnnouncements } from "./actions";

type Announcement = { id: string; text: string };

export function Announcements({ snapshot }: { snapshot: Snapshot<Announcement[]> }) {
  const [seed, setSeed] = useState(snapshot);

  // A newer server render always wins over whatever this component fetched for itself.
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
    <ul>
      {state.map((announcement) => (
        <li key={announcement.id}>{announcement.text}</li>
      ))}
    </ul>
  );
}
```

```ts
// app/actions.ts
"use server";

import type { Snapshot } from "@flefebvre/next-sse/client";

import { listAnnouncements, type Message } from "@/lib/messages";
import { sse } from "@/lib/sse";

export async function latestAnnouncements(): Promise<Snapshot<Message[]>> {
  return sse.snapshot(() => listAnnouncements());
}
```

**Handing the hook a new Snapshot is what closes the loop.** It re-seeds the state *and* reopens
the Channel from the position that read was taken at, so nothing published in between is missed.
An `onReset` that only refetches data — without going through `sse.snapshot` — leaves the
Connection resuming from a position that is still gone.

`sse.snapshot` is not Server-Component-only. It is the App asking its log where it stands and
reading its data in that order, which a server action does exactly as a page does.

## Override App-wide

`<SSEProvider>` takes no callback — a Server Component cannot be handed one — so compose the
client provider:

```tsx
// app/providers.tsx
"use client";

import { SSEClientProvider, type ClientChannels } from "@flefebvre/next-sse/client";
import type { ReactNode } from "react";

export function Providers({
  channels,
  children,
}: {
  channels: ClientChannels;
  children: ReactNode;
}) {
  return (
    <SSEClientProvider channels={channels} onReset={() => void refetchEverything()}>
      {children}
    </SSEClientProvider>
  );
}
```

```tsx
// app/layout.tsx
import { toClientChannels } from "@flefebvre/next-sse/server";

import { sse } from "@/lib/sse";

import { Providers } from "./providers";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers channels={toClientChannels(sse)}>{children}</Providers>
      </body>
    </html>
  );
}
```

A hook with its own `onReset` overrides both.

## When a Reset happens

- The client was away longer than the retention window, or the log trimmed past its position under
  load.
- A single-Instance App on the Memory Transport restarted ([deployment.md](../deployment.md)).
- A Transport outage lasted long enough that the position the Instance resumed from was gone.

It is not an error, and it is not a `status`: the Connection was live throughout. Widening
retention makes it rarer ([deployment.md](../deployment.md)).

## Notes

- Write an override where the refresh is genuinely too much: a heavy route, a form the reader is
  in the middle of, or a panel whose data is the only thing worth reading again.
- Testing it: `FakeEventSource.emit("reset", { cursor: "cursor-9" })` drives one by hand
  ([testing your app](testing-your-app.md)).
