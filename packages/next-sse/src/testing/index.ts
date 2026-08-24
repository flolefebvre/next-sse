export { transportContract } from "./transport-contract.js";
export type { TransportBackend, TransportContractOptions } from "./transport-contract.js";

/**
 * The Snapshot a component test hands its hook, sealed exactly as the server seals one.
 *
 * It ships here for the same reason the `EventSource` double does: a consumer testing a
 * component of their own has to produce what a Server Component would have handed it, and the
 * type is deliberately unopenable from outside (ADR-0007). Without this member the only way in
 * is a cast, in every consumer's suite (#46 widened this entry a second time; ADR-0009 records
 * the first).
 */
export { snapshotOf } from "./snapshot.js";

/**
 * The `EventSource`-shaped double the library's own client tests run on, and the recorder that
 * hands back every Connection opened through it.
 *
 * They ship together because a consumer test needs both: jsdom registers no `EventSource`, so
 * the test supplies the global, and what it then asserts on is the Connection that was opened —
 * `fakeEventSources()` is the only way to reach one without re-writing the recording subclass
 * in every project (this amends ADR-0009, which listed the class alone).
 *
 * ```ts
 * const fake = fakeEventSources();
 * globalThis.EventSource = fake.EventSource;
 *
 * render(<SSEClientProvider channels={channels} onReset={() => {}}>…</SSEClientProvider>);
 * fake.opened[0].ready();
 * fake.opened[0].message("chat:42", "message", { id: "1", text: "one" });
 * ```
 *
 * `onReset` is what keeps this to jsdom and nothing else: given one, the provider never reaches
 * for `next/navigation`, so a component test needs no App Router above it (ADR-0008).
 */
export { FakeEventSource, fakeEventSources } from "../client/fake-event-source.js";
