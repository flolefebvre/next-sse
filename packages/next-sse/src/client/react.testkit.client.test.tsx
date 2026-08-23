import { useEffect, useState } from "react";
import { expect, test } from "vitest";

import { flush, mount } from "./react.testkit.js";

/**
 * The harness the rest of the `client` project stands on, proved on a component that has
 * nothing to do with the library: it renders, its effects run, a macrotask turn reaches it,
 * and unmounting cleans up after itself.
 */
function Counter({ onGone }: { onGone: () => void }) {
  const [ticks, setTicks] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setTicks((seen) => seen + 1), 0);

    return () => {
      clearTimeout(timer);
      onGone();
    };
  }, [onGone]);

  return <output>{ticks}</output>;
}

test("the testkit mounts a tree, runs its effects and takes it down again", async () => {
  let gone = 0;
  const tree = await mount(<Counter onGone={() => (gone += 1)} />);

  expect(tree.container.textContent).toBe("0");

  await flush();

  expect(tree.container.textContent).toBe("1");

  await tree.unmount();

  expect(gone).toBe(1);
  expect(document.body.contains(tree.container)).toBe(false);
});

test("Strict Mode is asked for by name, and doubles the effect when it is", async () => {
  let gone = 0;
  const tree = await mount(<Counter onGone={() => (gone += 1)} />, { strict: true });

  expect(gone).toBe(1);

  await tree.unmount();

  expect(gone).toBe(2);
});
