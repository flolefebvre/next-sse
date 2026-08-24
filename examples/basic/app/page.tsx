import { connection } from "next/server";
import { Suspense } from "react";

import { listMessages } from "@/lib/messages";
import { ROOM_ID, sse } from "@/lib/sse";

import { Messages } from "./messages";

/**
 * The handoff, in the four lines an App writes for it.
 *
 * `sse.snapshot(read)` takes the Cursor before running the read and returns both as one opaque
 * value, so a Message published between the read and the stream going live is replayed to this
 * page rather than lost — and the word "cursor" appears nowhere here. The Snapshot crosses to
 * the Client Component as an ordinary prop.
 *
 * `connection()` is what keeps the read at request time: with Cache Components on, a component
 * that is not marked `use cache` and does not touch request data would otherwise be prerendered
 * at build, and a Snapshot baked into HTML resumes from a Cursor that is minutes or days old.
 */
async function Room() {
  await connection();
  const snapshot = await sse.snapshot(() => listMessages(ROOM_ID));

  return <Messages roomId={ROOM_ID} snapshot={snapshot} />;
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
