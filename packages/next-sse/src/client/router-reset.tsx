"use client";

import { useRouter } from "next/navigation.js";
import { useEffect, type RefObject } from "react";

/**
 * The default Reset behaviour, and the one place in the package that touches Next.js.
 *
 * A Reset means the App's state is behind a gap the library cannot describe, so the honest
 * answer is to fetch it again: `router.refresh()` re-runs the server components, each of them
 * mints a fresh Snapshot, and the new prop restarts the hook that holds it (ADR-0007). No App
 * code is involved, which is the whole point.
 *
 * It is a component rather than a hook call in the provider because `useRouter` throws when no
 * App Router is mounted above it. Rendering it only when the App gave no `onReset` of its own
 * keeps that cost where it belongs: an App — or a consumer's jsdom test — that supplies a
 * handler never reaches `next/navigation` at all, and the seam is one file wide.
 *
 * The specifier carries its extension because Next ships no `exports` map, so ESM resolution —
 * Node's and TypeScript's alike — needs the real file name; it is the same client-layer module
 * `next/navigation` names in an App, which is the one a `'use client'` module wants.
 */
export function RouterReset({ into }: { into: RefObject<(() => void) | undefined> }) {
  const router = useRouter();

  useEffect(() => {
    into.current = () => {
      router.refresh();
    };

    return () => {
      into.current = undefined;
    };
  }, [router, into]);

  return null;
}
