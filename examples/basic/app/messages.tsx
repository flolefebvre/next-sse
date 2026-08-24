"use client";

import { useState } from "react";

import { channels, useChannel } from "@/lib/sse.client";

/**
 * The Channel's Messages as they arrive. There is no `EventSource` here, no route path and no
 * Channel name: `channels.chat({ roomId })` is a Handle — a key and its params — and the hook
 * resolves it against the data the provider put in the tree.
 */
export function Messages({ roomId }: { roomId: string }) {
  const [messages, setMessages] = useState<string[]>([]);
  const { status } = useChannel(channels.chat({ roomId }), {
    /**
     * `payload` is `{ text: string }` here, and nothing in this file says so: the type comes
     * from the schema in the server-only Registry, through the `import type` in
     * `lib/sse.client.ts`.
     */
    message: (payload) => setMessages((seen) => [...seen, payload.text]),
  });

  return (
    <>
      <p data-testid="status">{status}</p>
      <ul data-testid="messages">
        {messages.map((text, index) => (
          <li key={index}>{text}</li>
        ))}
      </ul>
    </>
  );
}
