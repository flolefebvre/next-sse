import { ROOM_ID, sse } from "@/lib/sse";

import { Messages } from "./messages";

/**
 * Publish from a server action: the form posts, the action Publishes through the bound Handle,
 * and every Connection subscribed to that Channel — including the one this page holds — has the
 * Message before the action returns.
 */
async function send(formData: FormData): Promise<void> {
  "use server";

  const text = String(formData.get("text") ?? "");
  if (text === "") return;

  await sse.chat({ roomId: ROOM_ID }).message({ text });
}

export default function Home() {
  return (
    <main>
      <h1>next-sse example app</h1>
      <form action={send}>
        <input name="text" aria-label="Message" autoComplete="off" />
        <button type="submit">Publish</button>
      </form>
      <Messages roomId={ROOM_ID} />
    </main>
  );
}
