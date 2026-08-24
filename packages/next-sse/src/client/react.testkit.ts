import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

/**
 * The whole React harness of the `client` project (ADR-0009): mount a tree in jsdom — or
 * hydrate one over real `renderToString` output — let its effects run, take it down again. It
 * is deliberately small: `react-dom` and React's own `act` are enough, and a testing library
 * would still be a dependency bought before it is needed.
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
 * Render a tree the way a server does, then hydrate that markup with the same tree.
 *
 * This is the handoff as a page really performs it (ADR-0009): the list a reader sees first is
 * the server's HTML, and the hooks only start once React has adopted it. A test that mounted
 * client-side instead would prove the reducers and nothing about the seam — the Snapshot's
 * whole purpose is to make those two renders agree.
 */
export async function hydrate(ui: ReactNode): Promise<Mounted> {
  const container = document.createElement("div");
  container.innerHTML = renderToString(ui);
  document.body.append(container);

  const root = await act(async () => hydrateRoot(container, ui));

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

/**
 * Click the button with this label and let React catch up with whatever it caused.
 *
 * Labels rather than selectors, because that is what the tests are about: a component that
 * refetches, or opens a second room, or sends. Nothing here needs a query language.
 */
export async function click(container: HTMLElement, label: string): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) {
    throw new Error(`next-sse: no button labelled "${label}" in this tree.`);
  }

  await act(() => {
    button.click();
  });
}

/**
 * Do something the outside world does — deliver a frame, fire a timer — and let React catch up
 * with whatever it caused. Re-exported so a test never reaches for `act` itself.
 */
export { act };
