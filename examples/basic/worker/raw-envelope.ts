import { createClient } from "redis";

/**
 * The same Publish, written by a process that does not have the library at all: one `XADD` of
 * one JSON envelope, and every Connection of the App receives it.
 *
 * ```sh
 * REDIS_URL=redis://127.0.0.1:6379 pnpm exec tsx examples/basic/worker/raw-envelope.ts "hello"
 * ```
 *
 * This is the contract of ADR-0006, and it is the whole of it — a Go service, a Python job or a
 * `redis-cli` one-liner writes exactly this:
 *
 * - the key is `{<Prefix>}:log`, braces included: the Prefix sits inside the hash tag, so every
 *   key an App owns lands in one cluster slot, and the Prefix is the only thing keeping two Apps
 *   on one server apart;
 * - one field, `entry`, holding the envelope as JSON. `v` is the envelope version, `type` is
 *   `message` or `control`, and the rest is the Channel, the declared event name and the
 *   payload. A control entry — `{"v":1,"type":"control","control":"kick","key":"user-7"}` — is
 *   how a service outside Next.js revokes somebody's Connections;
 * - `MAXLEN ~ <cap>` rides on the write. The Instances trim regardless, and an external
 *   publisher that omits it lets the log grow between their trims.
 *
 * Nothing checks the payload against the App's schema on the way in or on the way out: what is
 * written here is what the client's typed hook will hand its component, so a publisher outside
 * the App owes the shape the Registry declares. The Cursor is minted by the log — the entry id
 * `XADD` answers — and nobody outside the Transport reads it.
 *
 * The command goes through `sendCommand` on purpose: what an external publisher owes is the
 * command, not any one client library's spelling of it.
 */
const RETENTION_CAP = "10000";

async function main(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === "") {
    throw new Error("This publisher needs REDIS_URL: the log it writes into is the App's.");
  }

  const prefix = process.env.NEXT_SSE_PREFIX ?? "next-sse";
  const envelope = {
    v: 1,
    type: "message",
    channel: "announcements",
    event: "posted",
    payload: { id: crypto.randomUUID(), text: process.argv[2] ?? "written straight to the log" },
  };

  const client = createClient({ url });
  client.on("error", (error: unknown) => {
    console.error(error);
  });

  await client.connect();

  /** The connection is closed on every path out, or a failed write leaves this process alive. */
  try {
    const cursor = await client.sendCommand([
      "XADD",
      `{${prefix}}:log`,
      "MAXLEN",
      "~",
      RETENTION_CAP,
      "*",
      "entry",
      JSON.stringify(envelope),
    ]);

    console.log(JSON.stringify({ published: envelope.payload.text, cursor: String(cursor) }));
  } finally {
    await client.close();
  }
}

/** In a function for the same reason as `publish.ts`: this package has no top-level `await`. */
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
