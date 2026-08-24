"use client";

import { useCallback, useEffect, useOptimistic, useRef, useState, useTransition } from "react";

import { cursorOf, type Snapshot } from "../internal/snapshot.js";

import type { ChannelState, Handle, Pending, Reducers, ResetOption } from "./handle.js";
import { useSSEContext } from "./provider.js";
import { useSubscription } from "./use-subscription.js";

/** One optimistic payload, waiting for the action that produced it to land. */
interface Sent {
  event: string;
  payload: unknown;
}

/**
 * The primary client shape (ADR-0007): the hook owns the state, seeds it from the Snapshot the
 * server component handed down, advances it with one reducer per event, and restarts it
 * whenever a new Snapshot arrives.
 *
 * The Snapshot is what makes it gap-free without a line of App code: it carries the position
 * the data was read at, the Connection reopens from there, and everything published in between
 * is replayed. Whatever a replay repeats — the overlap with the Snapshot, a Kick's replay, the
 * echo of something this page sent — is a duplicate the reducer absorbs, which is the whole job
 * of `upsertBy`.
 *
 * A new Snapshot prop restarting the state is what closes the Reset loop: the provider
 * refreshes the route, the server component reads again at a fresh Cursor, and this hook starts
 * over from it. Reset is never a status — the Connection was live throughout.
 */
export function useChannelState(
  handle: Handle,
  snapshot: Snapshot,
  reducers: Reducers,
  { onReset }: ResetOption = {},
): ChannelState {
  const [state, setState] = useState<unknown>(snapshot.data);

  /**
   * A new Snapshot is a new starting point, adopted while rendering rather than in an effect:
   * an effect would paint the old list once, and the refreshed server component is the App
   * saying that the old one is wrong.
   */
  const [seen, setSeen] = useState(snapshot);
  if (seen !== snapshot) {
    setSeen(snapshot);
    setState(snapshot.data);
  }

  /** The reducers are read when a Message arrives, so a fresh closure costs no reconnect. */
  const latest = useRef(reducers);
  useEffect(() => {
    latest.current = reducers;
  });

  /**
   * The updater form is unambiguous here even though the state is `unknown`: a Snapshot's data
   * crossed the RSC boundary as a prop, so it is something JSON can carry and never a function.
   */
  const apply = useCallback((event: string, payload: unknown): void => {
    const reduce = latest.current[event];
    if (reduce !== undefined) setState((current: unknown) => reduce(current, payload));
  }, []);

  const { status, channel } = useSubscription(handle, {
    cursor: cursorOf(snapshot),
    onMessage: apply,
    onReset,
  });

  const [sent, addSent] = useOptimistic<Sent[], Sent>([], (list, one) => [...list, one]);
  const [inFlight, startTransition] = useTransition();

  /**
   * `useOptimistic` shows a payload for exactly as long as the transition it was added in
   * lasts, and `apply` puts the real one into the state before that transition ends — so the
   * row never blinks, and there is no bookkeeping to undo when the action fails.
   */
  const act = (event: string, optimistic: unknown, action: () => Promise<unknown>): void => {
    startTransition(async () => {
      if (optimistic !== null) addSent({ event, payload: optimistic });
      apply(event, await action());
    });
  };

  return { state, status, channel, apply, act, inFlight, pending: group(useEvents(handle), sent) };
}

/** The events this Channel declares, as the provider carries them: the keys `pending` has. */
function useEvents(handle: Handle): readonly string[] {
  const { channels } = useSSEContext();

  return channels[handle.key]?.events ?? [];
}

/**
 * The optimistic payloads by event name, with an empty list for every event the Channel
 * declares. Plain data rather than a lazy lookup, so a component reading `pending.message` gets
 * the same array twice in one render and an unknown name is a type error, not `undefined`.
 */
function group(events: readonly string[], sent: readonly Sent[]): Pending {
  const pending: Record<string, unknown[]> = {};
  for (const event of events) pending[event] = [];
  for (const one of sent) (pending[one.event] ??= []).push(one.payload);

  return pending as Pending;
}
