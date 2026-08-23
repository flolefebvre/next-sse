import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

/**
 * The whole React harness of the `client` project (ADR-0009): mount a tree in jsdom, let its
 * effects run, take it down again. It is deliberately small — `react-dom/client` and React's
 * own `act` are enough for live-only components, and a testing library would be a dependency
 * bought before it is needed. The Snapshot handoff, which hydrates real `renderToString`
 * output, is the ticket that gets to reconsider that.
 *
 * The `.testkit.` in the name is what keeps this file out of the tarball: the package's build
 * config excludes the pattern, the way it excludes tests.
 */
const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
globals.IS_REACT_ACT_ENVIRONMENT = true;

/** A tree mounted in the document, and the way to take it down. */
export interface Mounted {
  /** The element the tree was rendered into, for reading what it produced. */
  readonly container: HTMLElement;
  /** Unmount it and take its container out of the document. Every mount owes this. */
  unmount(): Promise<void>;
}

/**
 * Render a tree into a fresh container and run its effects.
 *
 * `strict` wraps it in `StrictMode`, which in development doubles every mount into
 * setup → cleanup → setup. That burst is a first-class case for anything holding a Connection,
 * so a test asks for it by name rather than inheriting it.
 */
export async function mount(ui: ReactNode, { strict = false } = {}): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(strict ? createElement(StrictMode, null, ui) : ui);
  });

  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/**
 * Let one macrotask turn pass, with React flushing whatever it produces.
 *
 * This is the tick the client core coalesces Channel-set changes on: a test that has just
 * mounted or unmounted hooks calls this before asking what the core did about it.
 */
export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
