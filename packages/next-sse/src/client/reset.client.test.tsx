import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { beforeEach, expect, test, vi } from "vitest";

import { channels, DECLARED, installEventSource, useChannel } from "./app.testkit.js";
import type { FakeEventSource } from "./fake-event-source.js";
import { SSEClientProvider } from "./index.js";
import { act, flush, mount } from "./react.testkit.js";

/**
 * Reset, as an App experiences it (ADR-0007): the Instance says the Cursor is unusable, and
 * something fetches the state again. Nothing here is a status — the Connection is live
 * throughout — and the only question is who is told.
 *
 * This is the one file in the repo that reaches for a Next internal, and it is the only way to
 * prove the default without booting Next: `useRouter` reads `AppRouterContext`, so a test that
 * wants the default has to mount one. Every other test — here and in the whole client project —
 * passes an `onReset` instead and never touches `next/navigation`, which is what the provider's
 * composition buys. If a Next upgrade moves this module, the default's proof drops to e2e and
 * everything else is untouched.
 */
let opened: FakeEventSource[] = [];

beforeEach(() => {
  opened = installEventSource();
});

function Subscriber({ roomId = "42", onReset }: { roomId?: string; onReset?: () => void }) {
  const { status } = useChannel(channels.chat({ roomId }), {}, { onReset });

  return <p data-status={status} />;
}

/** An App Router that records nothing but the refetches the library asked it for. */
const aRouter = (refresh: () => void): AppRouterInstance =>
  ({
    refresh,
    back: () => {},
    forward: () => {},
    push: () => {},
    replace: () => {},
  }) as unknown as AppRouterInstance;

test("a Reset refetches the route, with no App code and once for the whole page", async () => {
  const refresh = vi.fn();
  const tree = await mount(
    <AppRouterContext.Provider value={aRouter(refresh)}>
      <SSEClientProvider channels={DECLARED}>
        <Subscriber />
        <Subscriber roomId="7" />
      </SSEClientProvider>
    </AppRouterContext.Provider>,
  );
  await flush();

  await act(() => {
    opened[0]?.emit("reset");
  });

  expect(refresh).toHaveBeenCalledTimes(1);
  expect(tree.container.querySelector("p")?.dataset.status).toBe("connecting");

  await tree.unmount();
});

test("an onReset on the provider replaces the refetch, and Next is never reached", async () => {
  const onReset = vi.fn();
  const tree = await mount(
    <SSEClientProvider channels={DECLARED} onReset={onReset}>
      <Subscriber />
    </SSEClientProvider>,
  );
  await flush();

  await act(() => {
    opened[0]?.emit("reset");
  });

  expect(onReset).toHaveBeenCalledTimes(1);

  await tree.unmount();
});

/**
 * A hook that knows how to refetch its own state says so, and the others are still covered by
 * the provider: overriding is per hook, not per page.
 */
test("a hook's own onReset overrides the provider's, for that hook alone", async () => {
  const provider = vi.fn();
  const mine = vi.fn();
  const tree = await mount(
    <SSEClientProvider channels={DECLARED} onReset={provider}>
      <Subscriber onReset={mine} />
      <Subscriber roomId="7" />
    </SSEClientProvider>,
  );
  await flush();

  await act(() => {
    opened[0]?.emit("reset");
  });

  expect(mine).toHaveBeenCalledTimes(1);
  expect(provider).toHaveBeenCalledTimes(1);

  await tree.unmount();
});
