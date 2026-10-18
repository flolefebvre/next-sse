import { recordPublishes } from "@flefebvre/next-sse/testing";
import { expect, test } from "vitest";

import { listMessages } from "@/lib/messages";

import { POST } from "./route";

/**
 * Testing server code of your own App that Publishes: call it, and assert on what it stored and
 * on what it Published.
 *
 * The route is imported for real, and with it the App's Registry: `@/lib/sse` calls `initSSE`,
 * which builds this process's Instance on the Memory Transport, since nothing sets `REDIS_URL`.
 * Nothing of the library is mocked and no Next.js runs — `./server` loads under plain Node like
 * any other module. `recordPublishes()` takes the log's position before the call, and the
 * reader it hands back returns what was Published after it, so each test sees its own Messages
 * and no reset is needed between them.
 *
 * The webhook is the target rather than the page's send action because it reads nothing from
 * `next/headers`; an action that reads `cookies()` needs a request scope only Next.js provides.
 */
const post = (body: unknown): Request =>
  new Request("http://localhost/api/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("a webhook call stores the Message and Publishes it on the room's Channel", async () => {
  const published = await recordPublishes();

  const response = await POST(post({ text: "  from the webhook ", roomId: "lobby" }));

  expect(response.status).toBe(200);
  const stored = listMessages("lobby");
  expect(stored.map(({ text }) => text)).toEqual(["  from the webhook "]);
  /**
   * The payload is the schema's Output: `chat`'s `message` trims its text, so what was Published
   * is the trimmed text the clients will see, under the id the store minted.
   */
  expect(await published()).toEqual([
    {
      channel: "chat:lobby",
      event: "message",
      payload: { id: stored[0]?.id, text: "from the webhook" },
    },
  ]);
});

test("a refused call stores nothing and Publishes nothing", async () => {
  const published = await recordPublishes();

  const response = await POST(post({ text: "never stored", roomId: "a:b" }));

  expect(response.status).toBe(400);
  expect(listMessages("a:b")).toEqual([]);
  expect(await published()).toEqual([]);
});
