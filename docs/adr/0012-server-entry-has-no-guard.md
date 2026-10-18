# `./server` has no import guard: keeping the Registry out of client code is the App's call

ADR-0008 made `./server` resolve to the implementation only under the `react-server` condition and to a module that throws everywhere else, so that a Client Component importing the App's Registry would fail at module load. **That guard is removed** (#92, superseding that clause of ADR-0008): `./server` has one target, the implementation, under every condition, and there is no `outside-react-server` module, no `react-server` branch in the exports map and no `sideEffects` entry for it.

The guard protected against one mistake and was no security boundary: Authorize runs on the server whether or not its code is also bundled for the browser, and Next.js inlines no server-only environment variable into client code. A realistic Registry module already pulls in what Next.js refuses in a Client Component (a session module reading `next/headers`), and an App that wants a hard guarantee has the ecosystem's tool for it: `import "server-only"` at the top of its Registry module. What the guard cost was every runtime that is not Next.js's RSC graph — an App's own server code under Vitest could not be loaded at all (#92), and setting the `react-server` condition there only moved the failure, since `./server` statically reaches the `'use client'` provider and React's `react-server` build has no hooks. A test of code that Publishes now imports it as Next.js does and runs it against a real Instance on the zero-config Memory Transport, with nothing of the library mocked.

## Consequences

- The library's own Vitest projects drop the `react-server` resolve condition: it existed to make tests resolve what the guard let through, and keeping it would test a condition the package no longer has. `pack:check` asserts the single target instead of the stub and the throw.
- An App that adds `import "server-only"` gets that package's throw back in its own tests; the docs say so in one line, and how the App handles it is its own decision.
- A process outside Next.js now _can_ import the Registry, but it need not and should not: it would load the App's Authorize and session code, install the Drain's signal handlers, and without `REDIS_URL` Publish into a Memory log no Instance reads. `createPublisher<typeof sse>` with an `import type` stays the one documented worker path (ADR-0008's "cannot import" now reads "should not").

## Considered Options

- Keep the guard and add an opt-in condition for test runners: rejected, it fixes Vitest alone and keeps every other cost — a plain Node script, a seed job, and the misleading message for legitimate server code.
- Switch the guard off by sniffing the environment (`VITEST`, `NODE_ENV`): rejected, the stub would have to import the implementation to hand it over, which puts it in every client bundle the guard was meant to keep it out of.
