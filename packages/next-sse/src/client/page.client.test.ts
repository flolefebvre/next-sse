import { afterEach, expect, test, vi } from "vitest";

import { browserPage } from "./page.js";

/**
 * The one place the library touches the page-lifecycle events themselves. The core is written
 * against three signals and knows nothing of the DOM; what has to be checked here is the
 * translation — which events make which signal, and that a browser firing only one of a pair
 * still gets exactly one signal out of it.
 */

const detachers: (() => void)[] = [];

afterEach(() => {
  for (const detach of detachers.splice(0)) detach();
  visibility("visible");
});

/** What `document.visibilityState` answers, which jsdom does not change by itself. */
function visibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

const listen = (signal: "hide" | "show" | "visible"): (() => void) => {
  const listener = vi.fn();
  detachers.push(browserPage().on(signal, listener));

  return listener;
};

test.each([
  ["the window's pagehide", () => window.dispatchEvent(new Event("pagehide"))],
  ["the document's freeze", () => document.dispatchEvent(new Event("freeze"))],
])("%s is a page being put away", (_case, fire) => {
  const listener = listen("hide");

  fire();

  expect(listener).toHaveBeenCalledTimes(1);
});

test.each([
  ["the window's pageshow", () => window.dispatchEvent(new Event("pageshow"))],
  ["the document's resume", () => document.dispatchEvent(new Event("resume"))],
])("%s is a page brought back", (_case, fire) => {
  const listener = listen("show");

  fire();

  expect(listener).toHaveBeenCalledTimes(1);
});

/**
 * `visibilitychange` fires in both directions and only one of them is the signal: going away is
 * not a reason to touch a Connection, and the core is never told about it at all.
 */
test("only the visible half of a visibility change is a signal", () => {
  const listener = listen("visible");

  visibility("hidden");
  document.dispatchEvent(new Event("visibilitychange"));

  expect(listener).not.toHaveBeenCalled();

  visibility("visible");
  document.dispatchEvent(new Event("visibilitychange"));

  expect(listener).toHaveBeenCalledTimes(1);
});

test("what a page listener detaches from, it stops hearing", () => {
  const listener = vi.fn();
  const detach = browserPage().on("hide", listener);

  detach();
  window.dispatchEvent(new Event("pagehide"));
  document.dispatchEvent(new Event("freeze"));

  expect(listener).not.toHaveBeenCalled();
});
