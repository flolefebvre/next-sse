import type { Instance } from "./instance.js";

/**
 * A Handle, as a Kick reads it: the Channel string it resolved to, and nothing else.
 *
 * It is the `RegistryLike` move — a real App's `Handle<Events>` is not assignable to
 * `Handle<EventMap>`, whose mapped type is an index signature over every possible event name —
 * so what takes one asks for exactly what it reads.
 */
export interface HandleLike {
  readonly name: string;
}

/**
 * What a Kick addresses: the Key an App gave the Connections it wants gone, or a bound Handle,
 * which is every Connection subscribed to that Channel.
 *
 * The two are told apart by `name` rather than by `key`, and that is deliberate: `name` is a
 * reserved event name, so a Handle always has it and it is always the Channel string, while an
 * App is free to declare an event called `key` — a Handle carrying a `key` method must not read
 * as a Kick by Key.
 */
export type KickTarget = { key: string } | HandleLike;

/**
 * Close Connections from the server so that they come back and go through Authorize again
 * (ADR-0003).
 *
 * It writes one control Entry through the Transport's single `publish` and resolves there: every
 * Instance reads that Entry off the log and ends the Connections it names with `reconnect`, so a
 * promise that waited for the Connections to close would be waiting on Instances it has no reply
 * channel from. Delivery is at-least-once and live-only — a replay skips the Entry, because
 * replaying a Kick would drop a Connection the fresh Authorize has just let back in.
 *
 * The Kick carries no reason: an App that wants to tell the user why publishes a Message on the
 * user's own Channel first, which arrives gap-free and is App data in App code rather than App
 * data in the library's control contract.
 */
export type Kick = (target: KickTarget) => Promise<void>;

export function createKick(instance: Instance): Kick {
  return async function kick(target: KickTarget): Promise<void> {
    if ("name" in target) {
      await instance.transport.publish({
        v: 1,
        type: "control",
        control: "kick",
        channel: target.name,
      });

      return;
    }

    await instance.transport.publish({
      v: 1,
      type: "control",
      control: "kick",
      key: keyOf(instance, target.key),
    });
  };
}

/**
 * The Key this Kick addresses, refused rather than published when it can name nothing.
 *
 * An App that configured no `key` has no Connection carrying one, so the Entry would be written,
 * fan out to every Instance and match nothing at all — a revocation that silently did not happen,
 * which is the one outcome ADR-0003 rules out.
 *
 * An empty Key is the same failure by another route, and no Connection can be hiding behind it:
 * the handler folds a `key` that comes out empty into no Key at all, so the two ends agree.
 */
function keyOf(instance: Instance, key: string): string {
  if (instance.key === undefined) {
    throw new Error(
      "next-sse: sse.kick({ key }) was called, and this App configured no `key`. Nothing here " +
        "knows who holds a Connection, so this Kick could only ever match nothing. Give " +
        "initSSE({ key }) a function, or Kick a Channel instead.",
    );
  }
  if (typeof key !== "string" || key === "") {
    throw new Error(
      `next-sse: sse.kick({ key }) takes the Key of the Connections to end, and was given ` +
        `${JSON.stringify(key) ?? String(key)}.`,
    );
  }

  return key;
}
