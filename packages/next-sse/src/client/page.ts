/**
 * What the core needs of the page it is running in, as the core thinks of it (ADR-0004):
 *
 * - `hide` — the page is going away or being frozen, so the Connection must be let go of.
 * - `show` — it is back, from the bfcache or from a freeze, and needs one again.
 * - `visible` — the user is looking at it again, which is a reason to stop waiting out a backoff
 *   and no reason at all to touch a Connection that is fine.
 *
 * It is an interface and not a reach for `window` because the core never reaches for a global:
 * its `EventSource` is injected for the same reason, and this is what lets the page transitions
 * be driven by a test rather than dispatched at a DOM.
 */
export type PageSignal = "hide" | "show" | "visible";

export interface PageLike {
  /** Listen for one transition. The function returned stops listening. */
  on(signal: PageSignal, listener: () => void): () => void;
}

/**
 * Which DOM events each signal is made of. `pagehide`/`pageshow` are the `window`'s and
 * `freeze`/`resume` are the `document`'s, and both pairs mean the same thing to the core: a
 * page put away, a page brought back. A browser that fires only one of a pair — and every one
 * of them fires at least one — is served by the same listener either way, which is why `show`
 * must be idempotent: a bfcache restore fires `resume` and then `pageshow`.
 *
 * `visibilitychange` is deliberately **not** part of `hide`. Closing on it would cost a
 * reconnect and a replay on every tab switch, and the heartbeat watchdog already catches a pipe
 * that died while the tab was in the background.
 */
const ON_WINDOW: Record<PageSignal, readonly string[]> = {
  hide: ["pagehide"],
  show: ["pageshow"],
  visible: [],
};

const ON_DOCUMENT: Record<PageSignal, readonly string[]> = {
  hide: ["freeze"],
  show: ["resume"],
  visible: ["visibilitychange"],
};

/**
 * The page as the browser tells it. Off the browser — a core built during a server render — it
 * is a page nothing ever happens to, so nothing is listened for and nothing has to know that
 * this module runs in both places.
 */
export function browserPage(): PageLike {
  if (typeof document === "undefined") return { on: () => () => undefined };

  return {
    on(signal, listener) {
      /**
       * `visibilitychange` fires in both directions, and only one of them is this signal: the
       * page becoming visible again. The other is the tab switch that must reopen nothing.
       */
      const fire =
        signal === "visible"
          ? (): void => {
              if (document.visibilityState === "visible") listener();
            }
          : listener;

      const attached: (() => void)[] = [];
      for (const type of ON_WINDOW[signal]) {
        window.addEventListener(type, fire);
        attached.push(() => {
          window.removeEventListener(type, fire);
        });
      }
      for (const type of ON_DOCUMENT[signal]) {
        document.addEventListener(type, fire);
        attached.push(() => {
          document.removeEventListener(type, fire);
        });
      }

      return () => {
        for (const detach of attached) detach();
      };
    },
  };
}
