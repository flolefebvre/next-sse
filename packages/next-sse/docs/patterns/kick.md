# Kick

Access changed, and an open stream must not outlive it. A Kick ends Connections so they come back
and go through Authorize again.

Example app:
[`app/api/kick/route.ts`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/api/kick/route.ts),
`kickMe` in
[`app/actions.ts`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/actions.ts),
[`app/role.tsx`](https://github.com/flolefebvre/next-sse/blob/main/examples/basic/app/role.tsx).

## Give Connections a Key

A Kick by Key needs an identity to address. It is derived once per Connection, from the context:

```ts
// lib/sse.ts
const { channel, createSSE } = initSSE({
  context: (request: Request): Session => sessionFrom(request.headers.get("cookie")),
  key: (session) => session.userId,
});
```

Kicking by Key with no `key` configured throws, rather than writing an entry that could only ever
match nothing.

## Kick somebody else

```ts
// app/api/kick/route.ts
import { sessionFrom } from "@/lib/session";
import { sse } from "@/lib/sse";

export async function POST(request: Request): Promise<Response> {
  const session = sessionFrom(request.headers.get("cookie"));
  if (session.role !== "admin") {
    return Response.json({ error: "Only an admin may kick." }, { status: 403 });
  }

  const { userId } = (await request.json()) as { userId?: string };
  if (typeof userId !== "string" || userId === "") {
    return Response.json({ error: "userId is required" }, { status: 400 });
  }

  await sse.kick({ key: userId });

  return Response.json({ kicked: true });
}
```

Every Instance acts on it: the one holding that user's stream need not be the one that took the
call. The guard is this route's own — Authorize decides who may *read* a Channel and is never
asked about anything else.

`await sse.kick(...)` resolves when the revocation is **in the log**, not when the Connections
close. There is nothing to wait for: the Instances that close them are on the far side of the log.

## Kick a whole Channel

```ts
await sse.kick(sse.chat({ roomId })); // every Connection subscribed to chat:<roomId>
```

Useful when a room is archived or its membership rules changed: everybody re-Authorizes, and
whoever no longer qualifies comes back with that one Channel `refused` while the rest of their
page keeps streaming.

## Kicking the session you just changed

**When the session about to be re-Authorized is the one you just changed, Kick from the next
request, not from the same one.**

```tsx
// app/role.tsx
"use client";

import { kickMe, switchRole } from "./actions";

export function RoleSwitch({ role }: { role: "admin" | "guest" }) {
  const next = role === "admin" ? "guest" : "admin";

  return (
    <form
      action={async () => {
        await switchRole(next); // request 1: writes the cookies
        await kickMe(); // request 2: ends the Connection, which reopens with them
      }}
    >
      <button type="submit">Become {next === "admin" ? "an admin" : "a guest"}</button>
    </form>
  );
}
```

```ts
// app/actions.ts
"use server";

export async function kickMe(): Promise<void> {
  const session = sessionFrom((await headers()).get("cookie"));
  await sse.kick({ key: session.userId });
}
```

Setting cookies and Kicking in one action is a race between two things nothing orders: the
`reconnect` travelling on the open stream, and the new cookies travelling in the action's
response. If the reconnect wins, the client re-Authorizes against the session it was just taken
out of, and nothing corrects it afterwards. Two calls, in order, make it deterministic — which is
why this is a Client Component: a server `formAction` can only be one call.

Kicking *another* user has no such race.

## Do not rotate the Key at the same time

A Kick can only end a Connection whose Key it names, and the Key a Connection carries is the one
it **opened** with. Change the identity and Kick the new one, and the entry matches nobody.

An App whose sign-in really does change identity Kicks the Key that is being left behind, before
the new one is anywhere.

## What the client sees

Nothing to write. The Connection is ended with `reconnect`, the client comes back at once with its
Cursor, surviving Channels lose nothing across the cut, and a Channel that is now refused surfaces
as `status === "refused"` on its own hook.

```tsx
const { status } = useChannelState(channels.admin(), snapshot, { notice: upsertBy("id") });
// "refused" once the reconnect has been re-Authorized
```

Remember the other half: a re-render is what changes the *page*, and a Kick is what changes the
*stream*. A role switch usually owes both.

## Notes

- A Kick carries no reason. To explain, publish a Message on the user's own Channel first — it
  arrives gap-free, and it is App data in App code.
- Delivery is at-least-once and live-only: a replay skips control entries, because replaying a
  Kick would drop a Connection the fresh Authorize just let back in.
- A service outside Next.js Kicks by writing the control entry itself
  ([wire-format.md](../wire-format.md)).
