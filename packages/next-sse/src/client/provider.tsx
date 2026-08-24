"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { createCore, type Core } from "./core.js";
import { RouterReset } from "./router-reset.js";

/** Where the SSE route lives unless an App says otherwise (ADR-0008). */
const DEFAULT_URL = "/api/sse";

/**
 * One Channel, as the client is allowed to know it: its name pattern and the events it
 * carries. This is the whole of what `<SSEProvider>` strips the Registry down to — no
 * Authorize, no Transport, no schema, nothing that could carry a database import into a
 * browser bundle (ADR-0002).
 */
export interface ClientChannel {
  readonly pattern: string;
  readonly events: readonly string[];
}

/** The App's Channels, by Registry key: what a client Handle is resolved against. */
export type ClientChannels = Readonly<Record<string, ClientChannel>>;

export interface SSEClientProviderProps {
  /** The Channel data, as `toClientChannels(sse)` produces it. */
  channels: ClientChannels;
  /** The SSE route this App serves. Client configuration only; the handler has no path. */
  url?: string;
  /**
   * What a Reset means for this App: its state is behind a gap, and it has to fetch it again.
   *
   * Omitted, the App gets `router.refresh()` and needs no code at all (ADR-0007). Supplying one
   * replaces it everywhere below, and a hook that wants its own overrides both. This is the
   * callback `<SSEProvider>` cannot take, which is why this provider is public (ADR-0008).
   */
  onReset?: () => void;
  children?: ReactNode;
}

interface SSEContextValue {
  channels: ClientChannels;
  core: Core;
}

const SSEContext = createContext<SSEContextValue | null>(null);

/**
 * The client half of the provider: the Channel allowlist, and the one Connection the whole
 * tree shares.
 *
 * It is public (ADR-0008) so an App that needs to compose rather than mount the Server
 * Component can. Everything a Server Component cannot pass — a callback, and so the Reset
 * behaviour — belongs on this one when its ticket lands.
 */
export function SSEClientProvider({
  channels,
  url = DEFAULT_URL,
  onReset,
  children,
}: SSEClientProviderProps) {
  /**
   * The two places a Reset can be handled, read when one happens rather than when the core is
   * built: what the App passed, and what `<RouterReset>` registered when it passed nothing.
   * Cells rather than a rebuilt core, because the core outlives every render.
   */
  const given = useRef(onReset);
  const fromRouter = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    given.current = onReset;
  });

  /**
   * One core for the life of the provider, built once and never rebuilt: a re-render that made
   * a second one would make a second Connection. A lazy `useState` initialiser rather than an
   * effect, because a hook mounting below subscribes on its own first effect, which runs
   * before the provider's would.
   */
  const [core] = useState(() =>
    createCore({
      url,
      onReset: () => (given.current ?? fromRouter.current)?.(),
    }),
  );

  return (
    <SSEContext.Provider value={useMemo(() => ({ channels, core }), [channels, core])}>
      {onReset === undefined && <RouterReset into={fromRouter} />}
      {children}
    </SSEContext.Provider>
  );
}

/** The provider's value, or a message naming what is missing above the component that asked. */
export function useSSEContext(): SSEContextValue {
  const value = useContext(SSEContext);
  if (value === null) {
    throw new Error(
      "next-sse: no <SSEProvider> above this component. Mount <SSEProvider sse={sse}> in a " +
        "layout, or <SSEClientProvider channels={toClientChannels(sse)}> if you compose it " +
        "yourself.",
    );
  }

  return value;
}
