import { headers } from "next/headers";
import { Suspense } from "react";

import { listMessages, listNotices } from "@/lib/messages";
import { sessionFrom } from "@/lib/session";
import { ROOM_ID, sse } from "@/lib/sse";

import { Messages } from "./messages";
import { Notices } from "./notices";
import { RoleSwitch } from "./role";

/**
 * The handoff, in the four lines an App writes for it.
 *
 * `sse.snapshot(read)` takes the Cursor before running the read and returns both as one opaque
 * value, so a Message published between the read and the stream going live is replayed to this
 * page rather than lost. No line of this App ever names a Cursor or holds one: the pair travels
 * as a single opaque value, and it crosses to the Client Component as an ordinary prop.
 *
 * Reading the request's headers is what keeps the read at request time: with Cache Components
 * on, a component that is not marked `use cache` and does not touch request data would otherwise
 * be prerendered at build, and a Snapshot baked into HTML resumes from a Cursor that is minutes
 * or days old. This one needs the session anyway — the `connection()` of the previous version
 * did nothing else.
 *
 * The admin Snapshot is the other half of the lesson: Authorize guards the stream, and the
 * server render guards the page. A guest is refused the `admin` Channel by the Registry, and is
 * handed no notices to render either — the two decisions are separate, and an App owes both.
 */
async function Room() {
  const session = sessionFrom((await headers()).get("cookie"));
  const messages = await sse.snapshot(() => listMessages(ROOM_ID));
  const notices = await sse.snapshot(() => (session.role === "admin" ? listNotices() : []));

  return (
    <>
      <RoleSwitch role={session.role} />
      <Messages roomId={ROOM_ID} snapshot={messages} />
      <Notices snapshot={notices} />
    </>
  );
}

export default function Home() {
  return (
    <main>
      <h1>next-sse example app</h1>
      <Suspense fallback={<p data-testid="status">loading</p>}>
        <Room />
      </Suspense>
    </main>
  );
}
