"use client";

import { useEffect, useState } from "react";

/**
 * The Channel's Messages as they arrive. This component hand-rolls its `EventSource` because
 * the client half of the library — the provider and the `useChannel` hooks that own the
 * Connection, the Cursor and reconnects — is not built yet. It is the one file that goes when
 * it is: an App is never meant to write this.
 */
export function Live({ roomId }: { roomId: string }) {
  const [messages, setMessages] = useState<string[]>([]);

  useEffect(() => {
    const source = new EventSource(`/api/sse?channel=chat:${roomId}`);

    source.addEventListener("message", (event: MessageEvent<string>) => {
      const { text } = JSON.parse(event.data) as { text: string };
      setMessages((received) => [...received, text]);
    });

    return () => {
      source.close();
    };
  }, [roomId]);

  return (
    <ul data-testid="messages">
      {messages.map((text, index) => (
        <li key={index}>{text}</li>
      ))}
    </ul>
  );
}
