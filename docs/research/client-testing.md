# Research: testing React hooks + EventSource + SSR handoff

Resolves issue #6 (part of the wayfinder map, #1). Researched 2026-08-23.

The question: how do we test, automatically and reliably, a React client that receives
initial data from a server component and then takes live updates over `EventSource`,
including the window between the two, such that the map's hard requirement (no Message
lost or duplicated across a reconnect, nor in the handoff window) is proven rather than
hoped for.

Glossary terms (App, Instance, Channel, Message, Publish, Connection, Transport,
Authorize, Prefix) are the map's. Every claim below carries its source; where a fact
could not be sourced, the text says so.

## TL;DR

- **No DOM shim ships `EventSource`.** jsdom 30.0.1 and happy-dom 20.11.6 both register
  `WebSocket` and `XMLHttpRequest` but not `EventSource` (verified in their source, see
  §3). Anything jsdom-based is therefore "mocked `EventSource`" by construction.
- **Node has a real `EventSource`**, undici's, spec-driven, with `Last-Event-ID` on
  reconnect and a tunable reconnection delay — but it is still flagged
  (`--experimental-eventsource`) on every Node line up to the v26.7.0 docs. Import it from
  the `undici` npm package instead, no flag needed (§5).
- **Playwright cannot fake a stream**: `route.fulfill` takes `string | Buffer` only
  (feature request #33564 still open). Against a real `next start` it does everything we
  need, and a stalled `page.route` handler is the deterministic way to put a Publish
  inside the handoff window (§4).
- **Vitest browser mode** gives a real browser `EventSource` and real React, but the
  test page is served by Vite, not Next.js: it cannot render a server component or
  hydrate Next's HTML. It is a component-test tool, and the Vitest docs themselves say to
  pair it with a standalone e2e runner (§2).
- **Recommendation** (§8): four levels, one runner. Unit and transport-contract tests in
  Vitest `node`; client integration in Vitest `jsdom` with a fake `EventSource` the
  library itself ships for consumers; protocol e2e in Vitest `node` with undici's
  `EventSource` against two `next start` Instances on one Valkey/Redis container
  (the `nextjs-redis-cache-handler` harness, reused); and a small browser e2e layer with
  the Playwright *library* inside the same Vitest e2e project for the handoff and
  reconnect scenarios that need real hydration. `@playwright/test` and Vitest browser
  mode are both left out of v0.1.

## 1. What the reference repos already do

All four reference repos run **Vitest 4** (4.1.x) and nothing else as a runner; none uses
Playwright, browser mode, jsdom or happy-dom today.

| Repo | Runner/config | Environment | Docker | Notable |
| --- | --- | --- | --- | --- |
| `ai-template` | `vitest.config.mts`: `pool: "forks"`, `isolate: true`, `globalSetup: tests/global-setup.ts`, `setupFiles: tests/setup.ts`, **`ssr.resolve.conditions: ["react-server"]`** | default (node) | Postgres via `@flefebvre/prisma-test-helper` (`createGlobalSetup({ image: "postgres:18-alpine" })`) | `gate` = `tsx scripts/gate.ts format:check,lint,duplication,typecheck,test,build`, ends in `--gate OK--`; CI on Node 24, one step per gate script |
| `next-pipe` | no vitest config (defaults) | node | none | client tests stub the network with `vi.stubGlobal("fetch", vi.fn(...))` + `vi.unstubAllGlobals()` in `afterEach` (`src/client.test.ts`); `typecheck:dist` consumer fixture; CI Node 22 |
| `nextjs-redis-cache-handler` | `vitest.config.ts` with **three `projects`**: `unit` (`groupOrder: 0`), `integration` (`*.integration.test.ts`, `globalSetup: tests/global-setup.ts`, forks, `groupOrder: 1`), `e2e` (`e2e/**/*.e2e.test.ts`, own `globalSetup`, `fileParallelism: false`, `testTimeout: 60_000`, `hookTimeout: 180_000`, `groupOrder: 2`) | node for all three | `testcontainers` ^12.1.0, `GenericContainer("valkey/valkey:8")` with `Wait.forLogMessage(/Ready to accept connections/)` | `gate` runs `test` (unit+integration), `build`, …, `test:e2e` last; CI has a separate `e2e` job and a server-image `matrix` job (`valkey 7.2 / 9`, `redis 6.2 / 8`) |
| `prisma-test-helper` | `unit` + `integration` projects | node | `@testcontainers/postgresql` | exports a Vitest `globalSetup` factory and a per-worker `setup`; peer `vitest ^4.0.0` |

Sources: `package.json`, `vitest.config.*`, `tests/`, `e2e/`, `.github/workflows/ci.yml`
and `docs/codebase/testing.md` of each repo, read via `gh api repos/flolefebvre/<repo>/contents/<path>`
on 2026-08-23.

### 1.1 The cache handler's e2e harness is directly reusable

`nextjs-redis-cache-handler/e2e/` already solves "two Instances against one Redis
container, driven from Vitest":

- `e2e/global-setup.ts` starts one container for the run (or uses `CACHE_TEST_REDIS_URL`),
  runs `next build` of a fixture app, and `project.provide(...)`s the result to workers.
- `e2e/instances.ts` `startInstance()` does `spawn(NEXT_BIN, ["start", "-p", port], { cwd: FIXTURE_DIR, env })`
  on a `freeHostPort()`, pipes stdout/stderr to a per-Instance log file, waits until the
  URL serves, and returns `{ url, stop }`. `startInstances("<scenario>")` starts an `A`/`B`
  pair with a fresh key prefix; `instances.logged(instance, text)` waits a log line out.
- `tests/redis-container.ts` `startOutageRedis()` starts a container on a **fixed** host
  port so it can be stopped/restarted at the same URL, and implements `pause()`/`unpause()`
  through `getContainerRuntimeClient()` because "a started container exposes no pause of
  its own" (testcontainers' own docs list `stop`, `restart`, `withReuse`, Ryuk cleanup but
  no pause: `docs/features/containers.md` at testcontainers-node v12.1.0).
- The fixture app is a workspace package importing the library **by package name through
  `exports`**, never from `src`/`dist` — the same posture the map wants for
  `examples/basic`.

The map already designates this repo as "the sibling for everything Redis"; its e2e
harness (Instances, container, log waiting, fixed-port outage server) is the starting
point for next-sse's e2e project, with the cache-specific parts (recording handler, two
builds, `markersOnce*`) dropped.

### 1.2 A constraint inherited from `ai-template`

`ai-template` sets `ssr.resolve.conditions: ["react-server"]` globally, so its Vitest
process resolves React's **server** build. A project that hydrates client components
(jsdom or browser) cannot share that condition: next-sse needs at least two Vitest
projects — a server-side one (may keep `react-server`) and a client one (must not).
Vitest 4 `test.projects` with `extends: true` is the sanctioned way to do this in one
config and one run; `vitest.workspace` "is deprecated since 3.2 and replaced with the
projects configuration" (Vitest docs, *Test Projects*, v4.1.11).

## 2. Candidate A — Vitest browser mode, Playwright provider

**What it is.** Vitest runs test files inside an iframe of a page served by the **Vite
dev server** ("Vitest uses the Vite dev server to run your tests … Your tests will run
inside an iframe in the center"; default port 63315). Providers: `@vitest/browser-playwright`
(recommended, "supports parallel execution"), `@vitest/browser-webdriverio`,
`@vitest/browser-preview` (dev only). Config:

```ts
import { playwright } from "@vitest/browser-playwright";
export default defineConfig({
  test: { browser: { enabled: true, provider: playwright(), instances: [{ browser: "chromium" }] } },
});
```

`browser.headless` defaults to `process.env.CI`. `vitest-browser-react` 2.2.0 (peer
`vitest ^4.0.0`, React 18/19) gives `render()` with locators. Sources: Vitest docs *Browser
Mode* guide, *browser.headless*, *browser.instances* (v4.1.11);
`vitest-community/vitest-browser-react/package.json`.

**Why it exists, in its own words.** jsdom/happy-dom "only simulate a browser environment
and not an actual browser, which may result in some discrepancies"; browser mode runs
"natively in a browser" for "more accurate and reliable test results". The same page
states it is "in early stages of development", has "longer initialization times", and "It
is recommended that users augment their Vitest browser experience with a standalone
browser-side test runner like WebdriverIO, Cypress or Playwright." (*Why Browser Mode*).

**Against the ticket's questions.**

| Question | Answer |
| --- | --- |
| Real server component render + hydration + SSE takeover | **No.** The tester page is Vite's, not Next's. A server component cannot be rendered there (Next.js docs: "Vitest currently does not support [async Server Components] … we recommend using E2E tests"), and there is nothing to hydrate. What *can* be tested: a client component given the props a server component would have passed, then a real browser `EventSource` against a real SSE URL. |
| Reach a real SSE server | Yes, with a caveat: the test origin is `localhost:63315`, so an `EventSource` to a `next start` on another port is cross-origin and needs CORS on the SSE route (the route would have to send `Access-Control-Allow-Origin` and, for cookies, handle `withCredentials`). Vite's `server.proxy` could make it same-origin; whether Vitest's browser server honours `server.proxy` for a streaming response was **not verified**. |
| Reconnects / server-side disconnects | Client-side yes (`es.close()`, or stub `EventSource` with `vi.stubGlobal` — not verified in browser mode specifically). Server-side only if the SSE server is real and exposes a test hook to drop a Connection. |
| Publish in the handoff window | Only with a stubbed `EventSource` (deterministic) or a server test hook. No way to hold a real request from the test (that is Playwright's `page.route`, not exposed inside the iframe). |
| Assert no lost/duplicated Messages | Yes, same as any client test. |
| Two Instances on one Redis | Not from the browser; a custom *browser command* (runs in Node, receives Playwright `page`/`context`) could start them, but at that point the test is half in Node anyway. |
| CI cost | Playwright browser download + `--with-deps` per job (Playwright CI docs advise against caching: restore time "is comparable to the time it takes to download the binaries"). Chromium only. |
| Flakiness | Moderate: real browser timing, plus "early stages" caveat from the docs. |
| `pnpm gate` fit | One more Vitest project; but it needs a separate `vitest` invocation if the root config sets `react-server`. |

**Verdict.** Good component-test ergonomics, wrong layer for the handoff requirement. Not
needed for v0.1 — the real-browser coverage it would give is obtained at the e2e level
instead (§4), where Next.js is actually in the loop.

## 3. Candidate B — jsdom / happy-dom + mocked `EventSource`

**Status of `EventSource` in the shims (verified in source, 2026-08-23).**

- jsdom v30.0.1 (`lib/jsdom/living/interfaces.js`) registers `XMLHttpRequest*` and
  `WebSocket`; no `EventSource` anywhere in the tree (`git/trees` grep for `eventsource`:
  no match). The README's "Unimplemented parts of the web platform" lists navigation and
  layout as the out-of-scope majors and otherwise says "it has many missing APIs". No open
  or closed jsdom issue titled with `EventSource` was found via the GitHub search API.
- happy-dom v20.11.6 (`packages/happy-dom/src/window/BrowserWindow.ts`) declares
  `WebSocket`, `XMLHttpRequest`, no `EventSource`; the only related issue (#1085) is about
  a Bun registrator crash on `window.EventSource` and was fixed — i.e. the property is
  absent by design, not broken.
- Node 22.3+/20.18+ ships `EventSource` as a global only behind `--experimental-eventsource`
  (Node docs *Globals*, v26.7.0: "Stability: 1 - Experimental"; locally: Node 25.9.0
  prints `typeof EventSource === "undefined"` unflagged, `"function"` with the flag).
  Vitest workers would need `NODE_OPTIONS=--experimental-eventsource` for the global to
  exist — not recommended; import it instead (§5).

So in a jsdom project `globalThis.EventSource` is `undefined` and the hook under test must
be given one. Two ways:

1. **A fake `EventSource` the test drives**: a small `EventTarget` subclass with
   `readyState`, `url`, `close()`, and test-side `emit(event, data, id)` /
   `fail()` / `open()` helpers, installed with `vi.stubGlobal("EventSource", Fake)` and
   removed by `vi.unstubAllGlobals()` (Vitest `vi` API: `stubGlobal` "Changes the value of
   global variable … restore … by calling `vi.unstubAllGlobals`", which covers
   `globalThis`/`window` in jsdom/happy-dom). This is exactly `next-pipe`'s
   `stubFetch` pattern applied to `EventSource`.
2. **MSW `sse()`** (msw 2.15.0, `src/core/sse.ts`): a first-class SSE handler with
   `client.send({ id, event, data })`, `client.error()`, `client.close()`, `retry`.
   Its constructor asserts `typeof EventSource !== 'undefined'`, and the PR that added it
   (#2299) notes "While `EventSource` doesn't exist in Node.js, it exists in Deno"; its
   tests live under `test/browser/sse-api/`. Whether `msw/node` intercepts undici's
   `EventSource` in a jsdom Vitest project was **not verified** — treat MSW as a browser
   (service-worker) option, not a jsdom one, until a spike says otherwise.

**Hydration in jsdom.** `@testing-library/react` 16.3.2 (peer React 18/19) `render(ui, { hydrate: true, container })`
calls `ReactDOMClient.hydrateRoot` (`src/pure.js`). Combined with `react-dom/server`
`renderToString` of the *client* component tree given server-shaped props, a jsdom test
can run the exact sequence the browser runs: HTML with initial data → hydrate → hook
effect opens `EventSource` → Messages flow. What it cannot do is run the **server
component** or Next's RSC payload; the "initial data" is handed to the test by hand.

**Against the ticket's questions.**

| Question | Answer |
| --- | --- |
| Real server component render + hydration + SSE takeover | Partial: real hydration of the client component over `renderToString` HTML, fake server component (props), fake `EventSource`. |
| Reconnects / server-side disconnects | **Yes, deterministically**: the fake fires `error`, flips `readyState`, records the `Last-Event-ID` the hook would send (the hook must expose the cursor it reconnects with, since the real `EventSource` sends the header itself — see open questions). |
| Publish in the handoff window | **Yes, deterministically**: emit Messages with ids below/at/above the initial cursor before `open`, assert which are applied. This is the one place the gap-free invariant can be enumerated exhaustively (cursor equal, behind, ahead, replay overlap). |
| Assert no lost/duplicated Messages | Yes; the hook's output is fully observable via `renderHook`/`result.current`. |
| Two Instances on one Redis | No (no server at all). |
| CI cost | Near zero; no Docker, no browser. |
| Flakiness | Lowest of all candidates; `vi.useFakeTimers` covers backoff/retry timers. |
| `pnpm gate` fit | One `client` Vitest project (`environment: "jsdom"`, no `react-server` condition), in `pnpm test`. |

**Verdict.** The right place for the hook's state machine, and the fake `EventSource` is
worth shipping as a public test helper (consumers of `useChannel`-style hooks will need
the same thing). It proves nothing about the real wire, the real browser parser, or the
server.

## 4. Candidate C — Playwright e2e against a running `next start`

**Next.js position.** "We recommend running your tests against your production code …
Run `npm run build` and `npm run start`, then run `npx playwright test`"; CI needs
`npx playwright install-deps` (Next.js docs, *Playwright*, 16.3.2). Next's own default
Playwright config uses `webServer: { command: process.env.CI === 'true' ? 'next start' : 'next dev', url: 'http://127.0.0.1:3000', reuseExistingServer: process.env.CI !== 'true' }`
(`packages/next/src/experimental/testmode/playwright/default-config.ts`). Playwright's
`webServer` accepts an array ("Multiple web servers (or background processes) can be
launched simultaneously"), default readiness timeout 60 s.

**Two ways to run it.**

- `@playwright/test` 1.62.1: its own runner, fixtures, web-first assertions, tracing,
  sharding. A second runner next to Vitest, a second config, a second reporter.
- `playwright` 1.62.1 **library** inside Vitest: "Use Playwright Library when integrating
  browser automation into … other test frameworks"; you lose "Built-in fixtures …
  Parallelization … Web-First assertions … Integrated tracing and reporting". Browser
  binaries via `npx playwright install chromium` or the `@playwright/browser-chromium`
  package that "auto-download[s] on npm install".

**Streaming and interception facts that decide the design.**

- `route.fulfill({ body })` is `string | Buffer`; "There is no option for streaming or
  ReadableStream bodies" and no way to "keep a fulfilled response open and write to it
  incrementally" (class Route docs). Feature request #33564 "Allow route fulfillment with
  a readable stream body" is **open** (filed 2024-11-13). Issue #15353 (closed 2022):
  maintainers say "there's no native support for event stream mocking" and suggest
  `context.addInitScript()` to stub the `EventSource` constructor plus
  `context.exposeFunction()` to talk back. → **Playwright mocks SSE only by stubbing
  `EventSource`; otherwise the SSE server must be real.**
- A `page.route`/`context.route` handler makes "every request matching the url pattern …
  stall unless it's continued, fulfilled or aborted" (class BrowserContext docs). That
  stall is the tool for the handoff window: intercept the Connection request, Publish
  through a test route on Instance B, then `route.continue()`. The Message is now provably
  published after the HTML was served and before the Connection existed.
- `route.abort()` kills a request; `browserContext.setOffline(true)` "Emulate[s] network
  being offline for the browser context" — two client-side ways to force a reconnect in a
  real browser, on top of server-side kicks.
- PR #41514 (merged 2026-07-01, first release after it is v1.62.0 on 2026-07-24; the
  release notes were not checked) fixed `waitUntil: 'networkidle'` hanging "on any page
  that opens an `EventSource`". Pin `playwright >= 1.62` and prefer `load` / explicit
  waits over `networkidle` anyway.
- `page.evaluate` runs in the page; "If the result is a Promise or if the function is
  asynchronous evaluate will automatically wait until it's resolved", so a test can read
  a `window.__nextSseTrace` the example app exposes, or call `EventSource`-level APIs
  directly.

**Against the ticket's questions.**

| Question | Answer |
| --- | --- |
| Real server component render + hydration + SSE takeover | **Yes, fully** — the only candidate that does. |
| Reconnects / server-side disconnects | Yes: `route.abort()`, `setOffline`, killing an Instance process (`SIGTERM`/`SIGKILL` on the spawned `next start`), a test-only kick route. |
| Publish in the handoff window | Yes, deterministically via the stalled `route` (above). |
| Assert no lost/duplicated Messages | Yes, by reading the DOM or a trace array via `page.evaluate`. |
| Two Instances on one Redis | Yes when the Instances are started by a Vitest global setup (cache-handler harness). Reconnecting *to the other* Instance needs something in front of both (see open questions). |
| CI cost | Browser download per job (no caching, per Playwright's advice) + `next build` + container. The cache handler's e2e job budget is 10 minutes with no browser; expect a few minutes more. |
| Flakiness | Highest of the four; Playwright recommends `workers: 1` in CI for "stability and reproducibility". Mitigate with one scenario per file, `fileParallelism: false`, waits on observable state, never sleeps. |
| `pnpm gate` fit | With the **library** inside the Vitest `e2e` project: `test:e2e` stays the last gate step and the CI `e2e` job only grows a `playwright install --with-deps chromium` step. With `@playwright/test`: a new script, config and reporter. |

**Verdict.** Required for the scenarios only a real browser can prove (hydration with the
real RSC payload, the browser's own `EventSource` reconnect and `Last-Event-ID`
behaviour, cookies on the Connection for Authorize). Keep it to a handful of scenarios
and run it through the Playwright library inside the existing Vitest e2e project.

## 5. Candidate D — Node/undici `EventSource` headless against the running app

**What it is.** undici's `EventSource` (`docs/docs/api/EventSource.md`, undici 8.10.0;
also what Node's flagged global is): "a WHATWG-conformant implementation of the
server-sent events interface". `import { EventSource } from "undici"` needs no Node flag.
Facts from the docs and `lib/web/eventsource/eventsource.js`:

- Sends `Accept: text/event-stream`, cache mode `no-store`; `withCredentials` maps to
  credentials `include`; a custom `dispatcher` (`node.dispatcher`) can add headers (the
  way to carry a session cookie for Authorize).
- `node.reconnectionTime` (default 3000 ms) sets the reconnect delay; the server's `retry`
  field overrides it. **Tests can set it to a few ms.**
- `#reconnect()` follows the spec verbatim: on stream end or failure, `readyState` →
  `CONNECTING`, fire `error`, wait, then re-fetch with
  `Last-Event-ID` set when the last event id is non-empty. `close()` aborts and never
  reconnects.
- Constructing one emits a one-time `ExperimentalWarning` (`UNDICI-ES`).

**Against the ticket's questions.**

| Question | Answer |
| --- | --- |
| Real server component render + hydration + SSE takeover | Half: `fetch` the page from `next start` and read the initial data + cursor out of the HTML (a `data-` attribute or script tag the example app renders), then open the Connection with that cursor. Real server component, real wire, **no React on the client side** — the hook is bypassed. |
| Reconnects / server-side disconnects | Yes: `close()` + new `EventSource`, or kill/restart an Instance and let undici reconnect with `Last-Event-ID` (tiny `reconnectionTime`). Both observable through `error`/`open` events and the server's log lines via `instances.logged`. |
| Publish in the handoff window | Yes, deterministically: fetch HTML → Publish on Instance B → open Connection with the HTML's cursor. No interception needed because the client is the test. |
| Assert no lost/duplicated Messages | Yes, exactly: collect `(id, data)` pairs and compare to the Published sequence. Also the natural home for "N Publishers × M Connections across A and B, every Message once" soak tests. |
| Two Instances on one Redis | Yes, straight from the cache-handler harness. |
| CI cost | `next build` + container; no browser. |
| Flakiness | Low: no DOM, no browser scheduler; Valkey/Redis pub/sub latency only. |
| `pnpm gate` fit | Fits the existing `e2e` project as-is. |

**Verdict.** The workhorse for the **Transport/wire contract end to end** — including
Valkey 8 / Redis 8 matrix cells like the cache handler's. Not a substitute for the
browser on hydration, but it isolates "server did the right thing" from "React did the
right thing", which makes the browser layer small.

## 6. Cross-cutting facts

- **Vitest 4 projects.** `test.projects: [{ extends: true, test: { name, environment, include, globalSetup, browser } }]`;
  run subsets with `--project <name>` (repeatable). Vitest's own wording: "define multiple
  project configurations within a single Vitest process" including node and browser ones.
- **Waiting.** `vi.waitFor` / `vi.waitUntil` default to 1000 ms timeout, 50 ms interval;
  the cache handler's `testing.md` already mandates `vi.waitUntil` over sleeps and
  `stopwatch()` over `Date.now()`.
- **Fake timers.** `vi.useFakeTimers` mocks `setTimeout`, `setInterval`, `setImmediate`,
  `Date` — fine for the hook's backoff in jsdom, useless (and to be avoided) once a real
  socket is involved; the cache handler's rule "no test … uses fake timers or a fake
  client" applies to integration and e2e only.
- **testcontainers-node 12.1.0** has `@testcontainers/valkey` and `@testcontainers/redis`
  modules, `container.restart()`, `stop({ removeVolumes })`, `withReuse()`, Ryuk cleanup
  (`TESTCONTAINERS_RYUK_DISABLED`); pause is via the runtime client (cache handler). The
  cache handler deliberately uses `GenericContainer` + `Wait.forLogMessage`, which keeps
  the image a single string (`CACHE_TEST_IMAGE`) for the matrix.
- **Node versions** in the family: `ai-template` CI on 24, `next-pipe` and the cache
  handler on 22. The `undici` package route (§5) works on both; the Node global does not
  without the flag on either.

## 7. Scorecard

| Capability | A. Vitest browser | B. jsdom + fake ES | C. Playwright vs `next start` | D. undici ES vs `next start` |
| --- | --- | --- | --- | --- |
| Server component render | no | no (props by hand) | **yes** | yes (HTML fetched) |
| Real hydration | no (Vite page) | partial (`renderToString` + `hydrateRoot`) | **yes** | no React |
| Real `EventSource` | yes (browser) | no | **yes** (browser) | yes (undici) |
| Deterministic handoff-window Publish | only with stub | **yes** | yes (stalled `route`) | **yes** |
| Reconnect (client-side) | yes | yes (fake) | yes (`abort`/`setOffline`) | yes |
| Server-side disconnect | needs hook | fake | yes (kill Instance / kick route) | yes |
| Lost/dup assertion | yes | **exhaustive** | yes | **exact, high volume** |
| Two Instances, one Redis | via command only | no | yes (harness) | **yes** (harness) |
| Docker needed | no (unless real server) | no | yes | yes |
| Browser download | yes | no | yes | no |
| Flakiness | medium | **lowest** | highest | low |
| Adds a runner | no | no | only if `@playwright/test` | no |

## 8. Recommended stack per test level

One runner (Vitest 4.1.x), four projects in `packages/next-sse/vitest.config.ts`, the
e2e project owning the example app in `examples/basic`. Gate order follows the cache
handler: `format:check,lint,duplication,typecheck,test,build,pack:check,typecheck:dist,test:e2e`.

### Unit (`unit` project, `environment: "node"`, Docker-free, `groupOrder: 0`)

- Scope: Channel registry types and validation (Standard Schema), Message encoding/wire
  format, replay buffer, cursor arithmetic, Memory Transport, `createSSE()` wiring, the
  framework-free client core's SSE parser/state machine fed synthetic frames.
- Tooling: Vitest 4.1.11, `vi.stubGlobal`/`vi.unstubAllGlobals` (next-pipe pattern),
  `vi.useFakeTimers` for backoff, type tests as in next-pipe (`Expect`/`IsEqual`).
- No `EventSource` at this level: the client core should accept an `EventSource`-shaped
  constructor as an injection point so the unit tests never touch a global.

### Transport contract (`integration` project, `*.integration.test.ts`, Docker, `groupOrder: 1`)

- Scope: the public Transport interface exercised by one shared suite run against both
  shipped Transports (Memory in-process, Redis via node-redis v6 against a container) —
  publish/subscribe fan-out across two Transport instances on one Prefix, ordering,
  Last-Event-ID replay, behaviour when Redis pauses (`startOutageRedis`).
- Tooling: `testcontainers` 12.1.0 `GenericContainer` + `Wait.forLogMessage`, copied from
  `nextjs-redis-cache-handler/tests/redis-container.ts` (image env var, provided-URL
  escape hatch, fixed-port outage server with `pause`/`unpause`); `inject("redisUrl")`
  from a `globalSetup`. Same CI matrix cells (`valkey/valkey:7.2`, `valkey/valkey:9`,
  `redis:6.2`, `redis:8`) — the map asks for Valkey 8 specifically; add it as a cell.

### Client integration (`client` project, `environment: "jsdom"`, Docker-free)

- Scope: the React hooks over the client core with a **fake `EventSource`**: initial
  props → `renderToString` → `render(..., { hydrate: true })` → Connection opens with the
  initial cursor → Messages at/below/above the cursor → reconnect with the right cursor →
  Channel-set change forces a reconnect → Authorize refusal closes the Connection.
  Enumerate the handoff-window cases here; this is where the gap-free invariant is proven
  combinatorially, cheaply.
- Tooling: `jsdom` 30.0.1 (Next's own Vitest guide uses jsdom; `happy-dom` 20.11.6 is
  equivalent here since neither has `EventSource`), `@testing-library/react` 16.3.2
  (`renderHook`, `render({ hydrate: true })`, `act`), a `FakeEventSource` class shipped
  by the library under a `@flefebvre/next-sse/testing` subpath so consumers can test
  their own components the same way.
- Project config: no `react-server` resolve condition (it would pull React's server
  build into the hydrating process — `ai-template` sets it globally, next-sse must not).

### Example-app e2e (`e2e` project, `e2e/**/*.e2e.test.ts`, Docker + built output, last in gate)

Two kinds of scenario file in the same project, both driving the cache handler's
Instance harness (two `next start` on free ports, one Valkey/Redis container for the run,
`instances.logged`, one scenario per file, `fileParallelism: false`):

1. **Protocol scenarios (headless, Node)** — `import { EventSource } from "undici"` (8.10.0,
   `node.reconnectionTime` set low). Fetch the page from A, read the cursor, Publish on B,
   connect to A with the cursor; kill A mid-stream and assert `Last-Event-ID` on the
   reconnect (from A's log or the server's own trace); cross-Instance fan-out; volume
   runs asserting every Message once. These are the bulk of e2e.
2. **Browser scenarios (Playwright library, 1.62.1 or later)** — three to five files:
   (a) real hydration then SSE takeover with a Publish inside a stalled `page.route` on the
   Connection URL; (b) `route.abort()`/`setOffline` reconnect, no loss/dup in the DOM; (c)
   Instance A killed while the page is connected, client recovers (through the proxy of
   open question 3, or against the restarted A on the same port); (d) Authorize denial on
   reconnect. Chromium only; `@playwright/browser-chromium` or
   `npx playwright install --with-deps chromium` in the CI `e2e` job; no
   `networkidle` waits.

Not adopted for v0.1: `@playwright/test` (second runner, second config, no gain over the
library for five scenarios), Vitest browser mode (no Next in the loop), MSW (browser-only
`sse()` today; revisit if the example app wants a service-worker mock story for consumers).

## 9. Open questions

1. **Where does the cursor live in the HTML?** Candidates C and D both depend on the
   server component exposing the initial cursor in a way a test can read (a `data-`
   attribute, a serialized prop, or the hook's own DOM marker). This is a public-API
   question for the server/client ticket, not a testing one, but it has to be decided
   before the e2e scenarios are written.
2. **How does the hook expose the cursor it reconnects with?** In jsdom the fake
   `EventSource` cannot see the `Last-Event-ID` header (the real one sets it internally).
   Either the hook passes the cursor in the URL on every (re)connect — then it is
   observable everywhere and the browser's own `Last-Event-ID` becomes redundant — or the
   fake has to be told the id by the hook. Interface decision.
3. **Reconnecting to the *other* Instance in e2e.** A browser `EventSource` reconnects to
   the same URL; to reach Instance B after A dies there has to be one URL in front of
   both. Options: a throwaway Node `http` proxy in the harness that forwards to whichever
   Instance is alive (streaming-safe, ~50 lines), or restarting A on its fixed port
   (cache-handler `startOutageRedis` style). Neither exists yet; the proxy also models
   real deployments better. Not researched beyond this.
4. **CORS for browser-mode reach-through** — moot if browser mode is not adopted; noted
   in case it is revisited.
5. **MSW `sse()` under `msw/node` + undici `EventSource`** — unverified; only matters if a
   consumer-facing mock story is wanted.
6. **Playwright release carrying #41514** — merged 2026-07-01; assumed in v1.62.0, release
   notes not read. Pin `>=1.62.1` regardless.
7. **Vitest browser server and Vite `server.proxy` for streams** — unverified; only
   relevant to candidate A.
8. **Valkey 8 cell** — the cache handler's matrix has `valkey/valkey:7.2` and `9`; the map
   asks for Valkey 8 by name. Decide whether to add `valkey/valkey:8` as the default
   integration image (the cache handler's `DEFAULT_TEST_IMAGE` is already `valkey/valkey:8`).
9. **Server-side disconnect hook in the example app** — a test-only route that kicks a
   Connection is the cheapest server-side disconnect for both e2e kinds; whether it ships
   gated behind an env var or lives only in the fixture is a spec decision.

## Sources

Reference repos (read via `gh api repos/flolefebvre/<repo>/contents/...`, 2026-08-23):
`ai-template` (`package.json`, `vitest.config.mts`, `tests/global-setup.ts`,
`tests/setup.ts`, `scripts/gate.ts`, `.github/workflows/ci.yml`, `docs/codebase/testing.md`);
`next-pipe` (`package.json`, `src/client.test.ts`, `.github/workflows/ci.yml`);
`nextjs-redis-cache-handler` (`package.json`, `vitest.config.ts`, `docs/codebase/testing.md`,
`tests/redis-container.ts`, `e2e/global-setup.ts`, `e2e/instances.ts`, `e2e/fixture-build.ts`,
`.github/workflows/ci.yml`); `prisma-test-helper` (`package.json`, `src/global-setup.ts`, `README.md`).

Vitest (docs v4.1.11, repo tag v4.1.6 via ctx7 `/vitest-dev/vitest`):
https://vitest.dev/guide/browser/ · https://vitest.dev/guide/browser/why ·
https://vitest.dev/api/browser/commands · https://vitest.dev/guide/projects ·
https://vitest.dev/api/vi.html · `docs/config/browser/headless.md`, `docs/config/browser/instances.md`;
`vitest-community/vitest-browser-react/package.json` (2.2.0).

Playwright (1.62.1): https://playwright.dev/docs/api/class-route ·
https://playwright.dev/docs/api/class-browsercontext · https://playwright.dev/docs/network ·
https://playwright.dev/docs/evaluating · https://playwright.dev/docs/test-webserver ·
https://playwright.dev/docs/ci · https://playwright.dev/docs/library ·
issues microsoft/playwright#15353, #33564, PR #41514.

Next.js 16.3.2 docs: https://nextjs.org/docs/app/guides/testing/playwright ·
https://nextjs.org/docs/app/guides/testing/vitest ·
`packages/next/src/experimental/testmode/playwright/default-config.ts` (via ctx7 `/vercel/next.js`).

Testing Library: https://testing-library.com/docs/react-testing-library/api/ ·
`testing-library/react-testing-library` `package.json` (v16.3.2) and `src/pure.js`.

DOM shims: `jsdom/jsdom` v30.0.1 `lib/jsdom/living/interfaces.js`, `README.md`;
`capricorn86/happy-dom` v20.11.6 `packages/happy-dom/src/window/BrowserWindow.ts`, issue #1085.

Node / undici: https://nodejs.org/api/globals.html (v26.7.0, `EventSource`);
`nodejs/undici` 8.10.0 `docs/docs/api/EventSource.md`, `lib/web/eventsource/eventsource.js`;
local check on Node 25.9.0.

MSW 2.15.0: `src/core/sse.ts`, PR mswjs/msw#2299, issue #2561,
`mswjs.io` docs `docs/sse/index.mdx`, `docs/sse/intercepting-sources/index.mdx`.

testcontainers-node 12.1.0: `docs/features/containers.md`, `docs/modules/valkey.md`.

npm `latest` on 2026-08-23: vitest 4.1.11, @vitest/browser-playwright 4.1.11,
vitest-browser-react 2.2.0, playwright 1.62.1, @playwright/test 1.62.1,
@testing-library/react 16.3.2, jsdom 30.0.1, happy-dom 20.11.6, msw 2.15.0,
testcontainers 12.1.0, @testcontainers/valkey 12.1.0, undici 8.10.0, next 16.3.2,
react 19.2.8, redis 6.2.1.
