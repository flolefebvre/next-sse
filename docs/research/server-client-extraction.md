# Extracting client-safe values from a server module in Next.js 16.3

Research for the typed Channel registry ([issue #8](https://github.com/flolefebvre/next-sse/issues/8)), part of the v0.1 map ([#1](https://github.com/flolefebvre/next-sse/issues/1)). Date: 2026-08-23.

**Question.** The App declares its Channels in one colocated file. That file holds values the browser needs at runtime (the Channel `pattern` strings, optionally the payload schemas) *and* code that must never reach the browser (`authorize`, `context`, and whatever they import: the DB client, the session helper). Is there any mechanism in Next.js 16.x / RSC / Turbopack / webpack / SWC by which the library, or the App with minimal config, can extract only the client-safe subset of that module's **values** into the client bundle at build time, so the App keeps one file?

Terms follow `CONTEXT.md`: an *App* is one Next.js application using the library; a *Channel* is a named stream; *Authorize* is the App-supplied per-Channel decision taken when a *Connection* opens.

Every claim below marked **[MEASURED]** was produced by building a real Next.js **16.3.2** app (React 19.2.0, Node 24.16.0) under both bundlers; the harness is in [Appendix A](#appendix-a-the-harness) and every recipe is reproducible from it. **[DOCS]** is an explicit statement in official documentation, **[SOURCE]** is read from implementation, **[INFERRED]** is reasoning over the two.

## Summary

- **There is no supported mechanism that splits a single authored module's values between the server and client graphs.** Next.js's own answer to this exact scenario is "split the file and let `server-only` turn a mistake into a build error" ([§2.1](#21-what-next-actually-recommends)). `'use server'` is the only directive that changes what a module means per graph, and it is the *opposite* of what we need: it guarantees the client sees **only opaque references and never any data** ([§1](#1-use-server-files)).
- **The naive colocated file leaks badly, and quietly.** With no `server-only` guard, a Client Component that reads `sse.channels.chat.pattern` gets a production chunk that also contains the verbatim `authorize` body and the inlined DB call, URL and all. In `next dev` the whole thing is served unminified. Turbopack's minifier dropped the *unused* `context` property but kept `authorize` — property-level DCE here is a minifier accident, not a guarantee ([§2.4](#24-what-actually-ships-measured)). **[MEASURED]**
- **`server-only` poisoning is resolve-time and reachability-blind**, and it fires in **two** client-side layers: the browser graph *and* the SSR graph that server-renders Client Components. Moving the import into `await import('./db')` inside `authorize` does not help — it still poisons, and without the poison it ships *more* code, in three separate lazy chunks ([§3](#3-lazy-dynamic-imports-inside-authorize)). **[MEASURED]**
- **Two build-time strip recipes actually work**, both requiring the App to add config to `next.config`, i.e. a `withSSE()` plugin in the style of `next-intl`:
  - **webpack (`next build --webpack`): a clean, complete solve.** A rule with `issuerLayer: { or: ['ssr', 'app-pages-browser'] }` running a loader that deletes the `authorize`/`context` properties strips both client-side layers *before* the poison check. The App keeps `import 'server-only'` and `next/headers` in its DB and session modules, the RSC/Route layer keeps the real `authorize`, and the browser bundle contains only the pattern ([§4.2](#42-webpack-issuerlayer-a-complete-solve)). **[MEASURED]**
  - **Turbopack (the default): a solve with a wart.** `turbopack.rules` `condition: 'browser'` is documented and works, but Turbopack's condition vocabulary (`browser | foreign | development | production | node | edge-light`) **cannot separate the RSC layer from the SSR layer** — `condition: 'node'` fires once for each. So the browser bundle can be cleaned, but the SSR layer still compiles the App's `authorize` and therefore still chokes on `server-only` and `next/headers`. Either the App forgoes those two guards (plain node deps such as `node:fs`/`node:crypto`/`pg` compile fine in the SSR layer), or the server-side import is written `./sse?server` so a `{ not: { query: /server/ } }` condition can exempt it ([§4.3](#43-turbopack-turbopackrules-condition-and-the-ssr-layer-problem)). **[MEASURED]**
- **`package.json` `exports` conditions do give the *library* three distinct implementations**, confirmed by measurement: the RSC/Route layer resolves `react-server`, the SSR layer resolves `node`/`default`, the browser resolves `browser`. This is worth using for next-sse's own package. It does **not** rescue the colocated file, because `authorize` and the App's `import { db }` are App source, not library source ([§2.3](#23-package-exports-conditions-measured-per-layer)). **[MEASURED]**
- Ruled out with reasons: SWC plugins (no client/server signal reaches a plugin; Wasm ABI pinned to Next's exact `swc_core`; fails open under Turbopack, silently under webpack — [§5](#5-swc-plugins)); `optimizePackageImports` / `modularizeImports` / `transpilePackages` / `serverExternalPackages` / `outputFileTracingExcludes` (all operate on module specifiers or on the server bundle, none on object properties — [§4.1](#41-the-config-knobs-that-are-not-this)); React `taint` (a runtime serialization guard, not a bundler feature, and defeated by any derived value — [§7](#7-react-taint-apis)); `'use cache'`, `proxy.ts`, Build Adapters (wrong axis — [§8](#8-next-16-specifics)).
- **Prior art points somewhere we had not been looking.** Build-time file splitting is canonical *outside* the App Router — React Router's `removeExports`, `vite-env-only`'s `serverOnly$()` macro, and Next's own `next_ssg` for `getServerSideProps` — but **no Next App Router library does it**, and none of them is property-granular. Inside the App Router the ecosystem converged on something else: **Payload strips the server-only keys at runtime on the server and hands the client config across as an RSC prop** (`createClientConfig` + `<RootProvider config={…}>`), and next-intl does the same with messages. Authorization is universally kept out of the shared file entirely — Payload evaluates `admin.condition` server-side and ships only the boolean; Inngest and Liveblocks mint a token in a server action; Zero built the serialize-permissions-to-an-AST machine and has now **deprecated** it because a rule that does a DB lookup cannot be expressed. next-safe-action, the closest analogue to our ideal, tells developers to write the schema **twice** ([§6](#6-codegen-and-ecosystem-prior-art)).
- **Recommendation for v0.1** ([§10](#10-recommendation-for-next-sse-v01)): do not build on a bundler transform. The colocated file can keep *all* of its values if the patterns reach the browser as an **RSC prop** from a `<SSEProvider>` the library ships, with the client handle being type-only — Payload's shape, and it costs no config, no codegen and no duplication. Variant **E** (client restates the patterns once, compiler-checked) remains the fallback if requiring a provider is unacceptable. Treat the loader-based strip as a **v0.2 opt-in**, never the foundation: it is Turbopack-conditional, config-invasive, and **fails open**.

## Sources

| Tag | Source |
| --- | --- |
| [PROBE] | Local experiment: Next.js 16.3.2 / React 19.2.0 / Node 24.16.0 probe app, both bundlers. Full harness in [Appendix A](#appendix-a-the-harness) |
| [NEXT-SCC] | Next.js docs, "Server and Client Components" § Preventing environment poisoning, <https://nextjs.org/docs/app/getting-started/server-and-client-components#preventing-environment-poisoning> |
| [NEXT-BOUNDARY] | Next.js docs, "Server and Client boundary", <https://nextjs.org/docs/app/guides/server-and-client-boundary> |
| [NEXT-SECURITY] | Next.js docs, "Data Security", <https://nextjs.org/docs/app/guides/data-security> |
| [NEXT-DIRECTIVES] | Next.js docs, Directives index, <https://nextjs.org/docs/app/api-reference/directives> |
| [NEXT-ERR-USESERVER] | Next.js error page `invalid-use-server-value`, <https://nextjs.org/docs/messages/invalid-use-server-value> |
| [NEXT-TURBOPACK-CFG] | Next.js docs, `turbopack` config, <https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack> |
| [NEXT-TURBOPACK-REF] | Next.js docs, Turbopack reference / unsupported features, <https://nextjs.org/docs/app/api-reference/turbopack> |
| [NEXT-WEBPACK-CFG] | Next.js docs, `webpack` config, <https://nextjs.org/docs/app/api-reference/config/next-config-js/webpack> |
| [NEXT-COMPILER] | Next.js docs, Next.js Compiler § SWC Plugins (experimental), <https://nextjs.org/docs/architecture/nextjs-compiler#swc-plugins-experimental> |
| [NEXT-TAINT] | Next.js docs, `taint` config, <https://nextjs.org/docs/app/api-reference/config/next-config-js/taint> |
| [NEXT-USECACHE] | Next.js docs, `use cache` directive, <https://nextjs.org/docs/app/api-reference/directives/use-cache> |
| [NEXT-PROXY] | Next.js docs, `proxy.ts` file convention, <https://nextjs.org/docs/app/api-reference/file-conventions/proxy> |
| [NEXT-FSCACHE] | Next.js docs, `turbopackFileSystemCache`, <https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopackFileSystemCache> |
| [NEXT-ADAPTER] | Next.js docs, `adapterPath`, <https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath> |
| [NEXT-CLI] | Next.js docs, `next` CLI § `next typegen`, <https://nextjs.org/docs/app/api-reference/cli/next#next-typegen-options> |
| [NEXT-16] | Next.js 16 / 16.1 / 16.3 blog posts, <https://nextjs.org/blog/next-16>, <https://nextjs.org/blog/next-16-1>, <https://nextjs.org/blog/next-16-3> |
| [SRC-ACTIONS] | `vercel/next.js` `crates/next-custom-transforms/src/transforms/server_actions.rs` (canary) |
| [SRC-LAYERS] | `vercel/next.js` `packages/next/src/lib/constants.ts` — `WEBPACK_LAYERS` |
| [SRC-WPCONFIG] | `vercel/next.js` `packages/next/src/build/webpack-config.ts` |
| [SRC-IMPORTMAP] | `vercel/next.js` `crates/next-core/src/next_import_map.rs` |
| [SRC-SERVERCTX] | `vercel/next.js` `crates/next-core/src/next_server/context.rs` — `should_use_react_server_condition()` |
| [SRC-CLIENTCTX] | `vercel/next.js` `crates/next-core/src/next_client/context.rs` |
| [SRC-WPRULES] | `vercel/next.js` `crates/next-core/src/next_shared/webpack_rules/mod.rs` — `WebpackLoaderBuiltinCondition` |
| [SRC-TPLOADER] | `vercel/next.js` `turbopack/crates/turbopack-node/js/src/transforms/webpack-loaders.ts` |
| [SRC-TPWARN] | `vercel/next.js` `packages/next/src/lib/turbopack-warning.ts` |
| [SRC-SWCPLUGIN] | `vercel/next.js` `crates/next-core/src/next_shared/transforms/swc_ecma_transform_plugins.rs` |
| [TEST-COND] | `vercel/next.js` `test/e2e/app-dir/webpack-loader-conditions/` (e2e fixture asserting per-environment loader output) |
| [REACT-USECLIENT] | React docs, `'use client'`, <https://react.dev/reference/rsc/use-client> |
| [REACT-USESERVER] | React docs, `'use server'`, <https://react.dev/reference/rsc/use-server> |
| [REACT-TAINT] | React docs, `experimental_taintObjectReference` / `experimental_taintUniqueValue`, <https://react.dev/reference/react/experimental_taintObjectReference> |
| [RFC-227] | reactjs RFC 0227 "Server Module Conventions" § `react-server` conditional exports, <https://github.com/reactjs/rfcs/blob/main/text/0227-server-module-conventions.md> |
| [WP-TREESHAKE] | webpack docs, Tree Shaking, <https://webpack.js.org/guides/tree-shaking/> |
| [SWC-PLUGINS] | SWC docs, "Selecting swc_core", <https://swc.rs/docs/plugin/selecting-swc-core>, and <https://plugins.swc.rs> |
| [PAYLOAD-CFG] | Payload, `packages/payload/src/config/client.ts` (`createClientConfig`, `serverOnlyConfigProperties`), `collections/config/client.ts`, `fields/config/client.ts`, `packages/ui/src/utilities/getClientConfig.ts`, `packages/ui/src/layouts/Root/index.tsx`, <https://github.com/payloadcms/payload> |
| [PAYLOAD-DOCS] | Payload docs, "Custom Components" overview (Client Config, importMap), <https://payloadcms.com/docs/custom-components/overview>, and Admin Panel location, <https://payloadcms.com/docs/admin/admin-panel-location> |
| [PAYLOAD-IMPORTMAP] | Payload, `packages/payload/src/bin/generateImportMap/index.ts`, `bin/build.ts`, `src/index.ts` (`payload.init()` auto-generate) |
| [CONVEX] | `get-convex/convex-js` `src/cli/codegen_templates/api.ts`, `src/server/api.ts` (`anyApi` Proxy); docs <https://docs.convex.dev/cli>, <https://docs.convex.dev/understanding/best-practices/other-recommendations> |
| [TRPC] | tRPC docs <https://trpc.io/docs>, <https://trpc.io/docs/client/vanilla/setup>, <https://trpc.io/docs/faq>; source `packages/server/src/unstable-core-do-not-import/createProxy.ts`, `packages/client/src/createTRPCClient.ts` |
| [NSA] | next-safe-action docs, "How it works" <https://next-safe-action.dev/docs/concepts/how-it-works> and React Hook Form integration <https://next-safe-action.dev/docs/integrations/react-hook-form> |
| [NEXT-INTL] | next-intl docs <https://next-intl.dev/docs/usage/plugin>, <https://next-intl.dev/docs/workflows/typescript>, <https://next-intl.dev/docs/environments/server-client-components>; source `src/plugin/getNextConfig.tsx`, `src/plugin/declaration/createMessagesDeclaration.tsx` |
| [PRISMA] | Prisma docs, v7 upgrade guide <https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7>, schema reference, Vercel deployment guide |
| [PANDA] | Panda CSS docs <https://panda-css.com/docs/installation/nextjs>, `config#gitignore`, `references/cli#codegen`; source `packages/node/src/builder.ts` |
| [SANITY] | `sanity-io/next-sanity` `packages/next-sanity/src/live/conditions/default/index.ts`, `fixtures/fail/server-only-live/package.json`; Sanity TypeGen docs <https://www.sanity.io/docs/apis-and-sdks/sanity-typegen> |
| [KEYSTATIC] | `Thinkmill/keystatic` `packages/keystatic/src/config.tsx`, `packages/keystatic/src/api/generic.ts`; docs `installation-next-js` |
| [ZERO] | `rocicorp/mono` `packages/zero-permissions/src/permissions.ts`, `packages/zero-schema/src/compiled-permissions.ts`, `packages/zero-cache/src/scripts/deploy-permissions.ts`, `packages/zero-cache/src/auth/load-permissions.ts`; docs <https://zero.rocicorp.dev/docs/auth> |
| [INNGEST] | `inngest/inngest-js` `packages/inngest/src/components/realtime/README.md`, `packages/realtime/src/{channel,api,hooks}.ts`; docs <https://www.inngest.com/docs/features/realtime> |
| [LIVEBLOCKS] | Liveblocks docs, TypeScript config <https://liveblocks.io/docs/api-reference/liveblocks-client#TypeScript> and Next.js access-token auth <https://liveblocks.io/docs/authentication/access-token/nextjs> |
| [RR-SPLIT] | React Router v7 `packages/react-router-dev/vite/plugin.ts` (`SERVER_ONLY_ROUTE_EXPORTS`), `vite/remove-exports.ts`; docs <https://reactrouter.com/explanation/code-splitting>, <https://reactrouter.com/api/framework-conventions/server-modules> |
| [VITE-ENV-ONLY] | `pcattori/vite-env-only` — `serverOnly$` / `clientOnly$` macros, <https://github.com/pcattori/vite-env-only> |
| [SRC-SSG] | `vercel/next.js` `crates/next-custom-transforms/src/transforms/next_ssg.rs` (Pages Router export elimination) |
| [TANSTACK] | TanStack Start, Server Functions guide, <https://tanstack.com/start/latest/docs/framework/react/guide/server-functions> |

## 0. The three graphs

Everything below turns on the fact that App Router code is compiled into **three** module graphs, not two. Next names them [SRC-LAYERS]:

| Layer (`WEBPACK_LAYERS`) | Runs where | Contains |
| --- | --- | --- |
| `rsc` (+ `api-node`/`api-edge` for Route Handlers, `middleware`, `instrument`) | server | Server Components, Route Handlers |
| `ssr` | **server** | Client Components, server-rendered for the initial HTML |
| `app-pages-browser` | browser | Client Components, shipped to the browser |

`WEBPACK_LAYERS.GROUP.clientOnly` is `['ssr', 'app-pages-browser']` [SRC-LAYERS] — the SSR layer is grouped with the browser, and that is why `server-only` fires there. Turbopack's error traces use the same taxonomy in prose: `Client Component Browser`, `Client Component SSR`, `Server Component`, `App Route` [PROBE].

**The recurring trap in this whole document is the SSR layer.** Anything that only cleans `app-pages-browser` leaves a build that still fails, or still compiles server code, in `ssr`.

## 1. `'use server'` files

**Verdict: impossible. It is the inverse of what we need.**

The rule is documented [NEXT-DIRECTIVES]:

> Every exported function covered by a file-level `'use server'` or `'use cache'` directive must be `async`. […] **The Client Component receives a reference that invokes the function on the server, not the function's code.**

and the dedicated error page names our exact case [NEXT-ERR-USESERVER]:

> This error occurs when a `"use server"` file exports a value that is not an async function. It might happen when you unintentionally export something like a **configuration object**, an arbitrary value, or missed the `async` keyword…

Measured, Next.js 16.3.2 + Turbopack, for a file exporting both a string and an async function [PROBE]:

```
Error: Only async functions are allowed to be exported in a "use server" file.
> 2 | export const pattern = 'chat:{roomId}'
    | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

It is a **build error**, raised by the SWC transform [SRC-ACTIONS], and it is fatal for the module as a whole: the second, downstream error in the same build is [PROBE]

```
Error: Export pattern doesn't exist in target module
The export pattern was not found in module [project]/lib/actions.ts [app-rsc] (ecmascript).
The module has no exports at all.
```

Two further details from source [SRC-ACTIONS], both relevant if one were tempted to smuggle the registry through:

- The build-time check rejects `Expr::Lit` only — `export const sse = createSSE({...})` (a call expression) passes the transform. But a runtime guard on the server layer, `ensureServerEntryExports`, then throws `A "use server" file can only export async functions, found object.` So the object escape is closed, just later.
- On the **client** layer the transform never emits the original statements at all; every export is replaced by `createServerReference(id, callServer, …)`. So even if a non-function export survived the check, `sse.channels.chat.pattern` on the client would read a property off an opaque proxy function: `undefined`.

`export *` and `export { x } from './x'` are likewise build errors [SRC-ACTIONS]. Note that React's own reference loader is *more permissive* (it skips non-function exports silently) — do not reason about Next from React here [SOURCE].

**Could `pattern` strings survive? No.** Not as a build error to work around; the client-layer output physically does not contain them.

## 2. `'use client'`, `server-only`, and export conditions

### 2.1 What Next actually recommends

[NEXT-SCC], verbatim:

> JavaScript modules can be shared between both Server and Client Components modules. This means it's possible to accidentally import server-only code into the client. […] To prevent accidental usage in Client Components, you can use the `server-only` package. […] Now, if you try to import the module into a Client Component, there will be a **build-time error**. […] Next.js handles `server-only` and `client-only` imports internally to provide clearer error messages when a module is used in the wrong environment. **The contents of these packages from NPM are not used by Next.js.**

That is the whole of the first-party story: *split the file, and let a build error catch the mistake*. There is no documented notion of one module with two implementations, other than package `exports` conditions ([§2.3](#23-package-exports-conditions-measured-per-layer)), which Next's docs never mention at all.

### 2.2 `'use client'` is a boundary, and a directiveless module is duplicated

[REACT-USECLIENT], verbatim:

> Add `'use client'` at the top of a file to mark the module **and its transitive dependencies** as client code.
>
> Code that is marked for client evaluation is **not limited to components**. **All code that is a part of the Client module sub-tree is sent to and run by the client.**
>
> Note that **a single module may be evaluated on the server when imported from server code and on the client when imported from client code.**

[NEXT-BOUNDARY] restates it: "**Code** crosses through imports. Whatever a Client Component imports is pulled into the client bundle."

So a directiveless `lib/sse.ts` imported by both a Route Handler and a Client Component is compiled into **both** graphs, and the client copy carries its whole transitive import chain. This is the baseline behaviour every mechanism below is fighting.

The inverse trick — mark the colocated file `'use client'` and import `authorize` from the server — is also closed [REACT-USECLIENT]: "When a server evaluated module imports values from a `'use client'` module, the values must either be a React component or supported serializable prop values… Any other use case will throw an exception."

### 2.3 Package `exports` conditions, measured per layer

A library *can* ship three different implementations of `createSSE`/`channel()`. Measured with a local package whose `exports` map is `{ "react-server": …, "browser": …, "node": …, "default": … }`, each variant exporting a distinct marker string [PROBE]:

| Layer | Condition selected | Where the marker landed |
| --- | --- | --- |
| Server Component (`rsc`) | **`react-server`** | `.next/server`, rendered into the HTML as `rsc-layer: COND_rsc_ZZZ` |
| Route Handler (`app-route`) | **`react-server`** | `.next/server` |
| Client Component **SSR** | **`node`** (falls to `default` if absent) | `.next/server/chunks/ssr/…`, rendered as `browser-layer: COND_node_ZZZ` |
| Client Component **browser** | **`browser`** | `.next/static/chunks/…` |

This matches source: `should_use_react_server_condition()` returns true only for `AppRSC | AppRoute | Middleware | Instrumentation` — **not `AppSSR`** [SRC-SERVERCTX]; the client context sets `browser: true` [SRC-CLIENTCTX]; webpack does the same via `reactServerConditionNames = ['react-server', ...conditionNames]` applied by `issuerLayer` for the RSC/middleware/instrument layers only [SRC-WPCONFIG]. `server-only` itself is nothing but this pattern: `{ "react-server": "./empty.js", "default": "./index.js" }` where `index.js` is a bare `throw` [SOURCE], per [RFC-227].

**Consequence for next-sse's own package**: put the real implementation on `react-server` and the stripped one on **`default`** (not merely `browser`), so the SSR layer is safe too. This is confirmed-by-measurement but *undocumented* in Next's docs — stable in practice (React itself depends on it), but it is not a promise.

**Consequence for the colocated file: none.** Conditions resolve a *specifier* to a different file. `authorize`, `context`, and `import { db } from './db'` live in the App's own source at a relative path. No `exports` map can reach them. Making `createSSE`/`channel()` no-ops in the browser does not remove the `authorize` closure that was passed to them, nor the module-level `import` that the closure needs.

### 2.4 What actually ships (measured)

Colocated file, no `server-only` anywhere, Client Component reads only `sse.channels.chat.pattern`, `next build` with Turbopack. The **entire** emitted client chunk [PROBE]:

```js
(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([…,17062,e=>{"use strict";
var t=e.i(43476),i=e.i(47167);
let r={async isMember(e,t){let r=await fetch(`https://internal.db.example/SECRET_DB_MARKER_ZZZ/${e}/${t}`,
  {headers:{authorization:`Bearer ${i.default.env.DB_TOKEN}`}});return(await r.json()).ok}},
  a={pattern:"chat:{roomId}",events:{message:{kind:"text"}},
     authorize:async({roomId:e},t)=>"AUTHORIZE_BODY_MARKER_ZZZ"!==t.user.id&&r.isMember(t.user.id,e)};
e.s(["ClientBit",0,function(){return(0,t.jsx)("div",{children:a.pattern})}],17062)}]);
```

Read that carefully:

- `authorize`'s body is present verbatim.
- The DB module was **inlined into the client chunk**, internal URL and auth-header shape included. (`process.env.DB_TOKEN` is *not* inlined — unprefixed env vars become `''` in the client build [NEXT-SCC] — but `e.i(47167)` is a `process` shim pulled into the browser to support the lookup.)
- The `context` property *was* dropped, and `getSession` with it. That asymmetry is the point: Turbopack's minifier fully inlined the outer object (only `.channels.chat.pattern` is read, so `context` died with it) but kept the inner object literal intact once it became a live binding. **Property-level DCE here is a minifier accident and cannot be relied on.**

Why it cannot be tuned into working: `createSSE({...})` is an opaque call whose *result is used*, so every PURE-family annotation is inapplicable — `/*#__PURE__*/` and `#__NO_SIDE_EFFECTS__` only drop a call "when their return value is unused" [WP-TREESHAKE], and even then they drop the *call*, not a property of a retained object. Turbopack's tree-shaking flags (`turbopackRemoveUnusedExports`, `turbopackRemoveUnusedImports`, `turbopackInferModuleSideEffects`, `turbopackScopeHoisting`) are all module/export granularity [NEXT-TURBOPACK-REF]. No bundler offers property granularity.

**Dev is worse.** With `next dev` on the same code, fetching `/` and downloading all 14 `/_next/static/**.js` the page references, every marker is present unminified [PROBE]:

```
SECRET_DB_MARKER_ZZZ         1
AUTHORIZE_BODY_MARKER_ZZZ    1
SESSION_MARKER_ZZZ           1
```

So even the accidental minifier stripping of `context` does not happen in development: the App's Authorize logic is readable in the browser devtools on every `next dev` page load.

### 2.5 Does tree-shaking beat the `server-only` poison? No — the poison is resolve-time

This was the sharpest sub-question, and the answer is unambiguous in both directions.

**Measured** [PROBE]: the colocated file, `lib/db.ts` starting with `import 'server-only'`, Client Component reading only `pattern` — `next build` fails:

```
./lib/db.ts:1:1
Error: 'server-only' cannot be imported from a Client Component module
> 1 | import 'server-only'
It should only be used from a Server Component.

Import traces:
  Client Component Browser:
    ./lib/db.ts [Client Component Browser]
    ./lib/sse.ts [Client Component Browser]
    ./app/client.tsx [Client Component Browser]
  Client Component SSR:
    ./lib/db.ts [Client Component SSR]
    ./lib/sse.ts [Client Component SSR]
    ./app/client.tsx [Client Component SSR]
```

Note both client-side layers are listed.

**Why, from source.** In Turbopack the client import map maps `server-only` to `ImportMapping::Error` with `IssueStage::Resolve` [SRC-IMPORTMAP] — the failure happens while the module reference is being *resolved*, before any optimization pass exists to shake anything. In webpack it is a `next-invalid-import-error-loader` whose whole body is `throw new Error(message)`, attached with `issuerLayer: { not: [...GROUP.serverOnly, ...GROUP.neutralTarget] }` [SRC-WPCONFIG] — loaders run during module *building*, and `optimization.usedExports` / `optimization.sideEffects` run strictly afterwards.

Next's own source comment settles it beyond doubt [SRC-WPCONFIG]:

> // Potential the bundle introduced into middleware and api can be poisoned by client-only
> // but not being used, so we disabled the `client-only` erroring on these layers.

They had to add an escape hatch *because the poison fires on imports that are present but unused*.

Even setting resolution aside, ESM semantics would forbid it: `server-only`'s body is a top-level `throw`, an unambiguous side effect, and the package ships **no `sideEffects` field** [SOURCE]. webpack states the rule plainly: "When a module has side effects, it cannot be tree-shaken even if it is not used" [WP-TREESHAKE].

**So: tree-shaking never runs before the poison check. Not in either bundler, not at any granularity.**

### 2.6 The SSR layer poisons more than `server-only`

Also measured, and decisive for the Turbopack recipe in [§4.3](#43-turbopack-turbopackrules-condition-and-the-ssr-layer-problem) [PROBE]:

| What the colocated file transitively imports | Client Component SSR layer |
| --- | --- |
| `import 'server-only'` | **build error** |
| `import { cookies } from 'next/headers'` | **build error** (with a misleading message, see below) |
| `import { readFileSync } from 'node:fs'`, `node:crypto` | **fine** — compiles, runs nowhere |

The `next/headers` error is worth quoting because the wording will confuse anyone who hits it — the SSR layer reports itself as the Pages Router:

```
Error: You're importing a module that depends on "next/headers". This API is only available
in Server Components in the App Router, but you are using it in the Pages Router.
```

The practical reading: a *realistic* DB client (pg, Prisma, drizzle — node builtins and native deps) compiles happily in the SSR layer. The things that break are precisely the two explicit App-Router guards. That is what makes the Turbopack browser-only strip *nearly* workable.

## 3. Lazy dynamic imports inside `authorize`

**Verdict: does not help. Strictly worse.**

Rewriting the colocated file so `authorize` does `const { db } = await import('./db')` and `context` does `const { getSession } = await import('./auth')`:

- With `server-only` present: **identical build error**, same two client-side layers [PROBE]. A statically analysable `import()` inside a never-executed function still creates a module reference, which is still resolved, which still hits the poison. Source agrees: Turbopack's analyzer visits function bodies unconditionally and accumulates their effects with no reachability gate [SOURCE]; the existence of the `turbopackIgnore`/`webpackIgnore` magic comments only makes sense because the default is always to bundle [NEXT-TURBOPACK-REF].
- Without `server-only`: the build succeeds and ships **three** separate lazy chunks to the browser instead of one inlined blob — `db`, `auth`, and the `authorize` closure each in their own file [PROBE]. `getSession`, which the static version's minifier had accidentally dropped, now survives.

There is one theoretically live escape hatch, and it fails for the same SSR reason as everything else. Next defines `process.env.NEXT_RUNTIME` as `''` in the browser compilation and `'nodejs'` on the node server [SOURCE], and Turbopack genuinely prunes a statically-false branch's *effects* (they are never queued as module references, so no resolution and no poison) [SOURCE]. So `if (process.env.NEXT_RUNTIME) { const { db } = await import('./db') }` would keep the browser graph clean. But the SSR layer is `isNodeServer`, so the branch stays live there and the poison fires anyway. There is no `typeof window` define in Next's client build to substitute [SOURCE].

## 4. Loaders and transforms

This is where something actually works.

### 4.1 The config knobs that are *not* this

| Knob | Ruling | Why |
| --- | --- | --- |
| `experimental.optimizePackageImports` | out | Barrel-file re-export pruning (`next-barrel-loader` rewrites `export {a} from './a'` to only the imported names). Never touches object properties. |
| `modularizeImports` | out | Regex/template rewriting of import *paths* (`import {X} from 'pkg'` → `import X from 'pkg/x'`). Cannot strip properties. Also now entirely undocumented — no `modularizeImports.mdx` exists in canary `docs/`, it survives only in the types and the zod schema [SOURCE]. |
| `transpilePackages` | prerequisite only | Opts a `node_modules` package into compilation; says nothing about *what* transform. Needed if Turbopack rules must reach inside `node_modules` (which also means dropping any `{not:'foreign'}` guard). |
| `serverExternalPackages` | out | Opposite direction: keeps a dep *out* of the server bundle and `require`s it natively. No client-side effect. |
| `experimental.serverComponentsExternalPackages` | gone | Renamed to top-level `serverExternalPackages` in v15.0.0; still deprecation-mapped [SOURCE]. |
| `outputFileTracingExcludes` | out | Post-build file tracing for `output: 'standalone'`. Runs after bundling; zero effect on module contents. |

### 4.2 webpack `issuerLayer`: a complete solve

The webpack hook receives `{ dir, dev, isServer, buildId, config, defaultLoaders, totalPages, webpack, nextRuntime }` [NEXT-WEBPACK-CFG], [SRC-WPCONFIG]. **Nothing in it identifies the layer** — measured, the hook runs three times [PROBE]:

```
[webpack hook] isServer=true  nextRuntime=nodejs    name=server        layers=true
[webpack hook] isServer=true  nextRuntime=edge      name=edge-server   layers=true
[webpack hook] isServer=false nextRuntime=undefined name=client        layers=true
```

and the `server` compiler contains *both* the `rsc` and `ssr` layers. But `experiments.layers` is on unconditionally [SRC-WPCONFIG], so a rule can target layers directly:

```js
// next.config.mjs
export default {
  turbopack: {},                       // MANDATORY — see below
  webpack(config) {
    config.module.rules.push({
      test: /lib[\\/]sse\.ts$/,
      issuerLayer: { or: ['ssr', 'app-pages-browser'] },   // = WEBPACK_LAYERS.GROUP.clientOnly
      use: [{ loader: require.resolve('next-sse/strip-loader') }],
    })
    return config
  },
}
```

**Measured result, with `import 'server-only'` left in place in `lib/db.ts` and `lib/auth.ts`** [PROBE]:

- Build **succeeds**. The loader ran twice — once in the `client` compiler (`target: 'web'`) and once in the `server` compiler (`target: 'node'`, i.e. the `ssr` layer). The `rsc` layer never saw it.
- `.next/static`: contains `chat:{roomId}`, contains **none** of the DB / authorize / session markers.
- `.next/server`: a Route Handler importing the same `lib/sse.ts` still gets the **real** `authorize`, `context`, `db` and `getSession`.

That is the whole problem solved, with the App keeping one file *and* keeping `server-only`. The strip happens during module building, before the poison loader would run, so the poisoned import no longer exists in those layers.

Caveats:

- `WEBPACK_LAYERS` is **not public API** — it lives in `packages/next/src/lib/constants.ts`, which is not re-exported from `next/constants` [SRC-LAYERS]. Hardcode `'ssr'` and `'app-pages-browser'`.
- **A library that injects a `webpack` hook must also set `turbopack: {}`**, or Next 16 hard-exits for every default-config user. Measured, `next build` with a `webpack` hook and no `turbopack` key: `exit=1` [PROBE], with

  ```
  ⨯ ERROR: This build is using Turbopack, with a `webpack` config and no `turbopack` config.
     This may be a mistake.
     NOTE: your `webpack` config may have been added by a configuration plugin.
     TIP: … you can silence this error by … simply setting an empty turbopack config
  ```

  (guard: `process.env.TURBOPACK === 'auto' && hasWebpackConfig && !hasTurboConfig` [SRC-TPWARN]).
- Webpack is not the default in Next 16; the App must run `next build --webpack` / `next dev --webpack`. So this recipe alone covers a shrinking minority.

### 4.3 Turbopack `turbopack.rules` `condition`, and the SSR-layer problem

The mechanism is documented [NEXT-TURBOPACK-CFG] and shipped with an e2e fixture asserting exactly the per-environment divergence we want [TEST-COND]. The shape in 16.3 [SOURCE, `config-shared.d.ts`]:

```ts
type TurbopackLoaderBuiltinCondition =
  'browser' | 'foreign' | 'development' | 'production' | 'node' | 'edge-light'
type TurbopackRuleCondition =
  | { all: TurbopackRuleCondition[] } | { any: … } | { not: … }
  | TurbopackLoaderBuiltinCondition
  | { path?: string | RegExp; content?: RegExp; query?: string | RegExp; contentType?: string | RegExp }
type TurbopackRuleConfigItem = { loaders?: …; as?: string; condition?: TurbopackRuleCondition; type?: … }
```

The field is `condition` (singular); "default" is written `{ not: 'browser' }`; `condition` landed in 16.0.0 and `query`/`contentType` in 16.2.0 [NEXT-TURBOPACK-CFG].

**Measured, `condition: 'browser'`** [PROBE]: the loader runs **exactly once**, only for the browser compilation. Returning stripped **TypeScript** from the loader works fine (no `as`/`type` needed for a `*.ts` glob) — a point the docs leave ambiguous. With no `server-only` in play, the browser bundle comes out containing only `chat:{roomId}`, while `.next/server` keeps the real `authorize`, `context` and `getSession`.

**The loader cannot detect its environment.** Measured, `this.target` and `this.mode` are `undefined` under Turbopack [PROBE] — consistent with the documented unsupported list (`this.mode`, `this.target`, `this.version`, `this.utils`, `this.resolve`, `this.emitFile`, general `this.fs`) [NEXT-TURBOPACK-CFG]. The environment must be passed in as a loader `option` on a `condition`-gated rule entry. Available: `this.resourcePath`, `this.resourceQuery`, `this.getOptions()`, `this.emitWarning/emitError`, `this.addDependency`, `this.fs.readFile`, `this.getResolve` [SRC-TPLOADER].

**And here is the blocker.** Measured with three log-only rules [PROBE]:

```
1 × condition: 'browser'    → lib/sse.ts
2 × condition: 'node'       → lib/sse.ts        ← the RSC/Route layer AND the SSR layer
0 × condition: 'foreign'
0 × condition: 'edge-light'
```

`condition: 'node'` fires **twice and indistinguishably**. There is no `react-server` built-in condition [SRC-WPRULES]. So under Turbopack you can clean the browser bundle, but you **cannot** strip the SSR layer without also stripping the RSC layer and destroying Authorize on the server. Which means the App's `server-only` / `next/headers` guards still break the build ([§2.6](#26-the-ssr-layer-poisons-more-than-server-only)) — measured: with `condition: 'browser'` stripping in place, `import 'server-only'` in `lib/db.ts` still fails, now with a *single* trace, `Client Component SSR` [PROBE].

Two ways out, both measured:

**(a) Forbid the two guards.** Keep `condition: 'browser'`, and require that nothing reachable from the colocated file imports `server-only` or `next/headers`. Realistic DB code is fine (`node:fs`, `node:crypto` compile in the SSR layer — measured [PROBE]). `next/headers` is avoidable by design: next-sse's `context(request)` already receives the `Request`, so session lookup can read `request.headers.get('cookie')` instead. Losing `server-only` is the real cost — it is exactly the guard that turns a future mistake into a build error.

**(b) A `?server` import query.** Strip everywhere *except* an import that carries a query, and have the server side use it:

```js
// next.config.mjs
turbopack: { rules: { '*.ts': [{
  condition: { not: { query: /server/ } },
  loaders: [{ loader: './strip-loader.cjs' }],
}]}}
```
```ts
// app/api/sse/route.ts
import { sse } from '../../../lib/sse?server'   // the only unstripped import
```

Measured [PROBE]: **build succeeds with `import 'server-only'` intact**; the loader runs twice (browser + SSR); `.next/static` contains only `chat:{roomId}`; `.next/server` keeps all three server markers. It is a full solve — at the cost of a magic import specifier that TypeScript cannot resolve without a `declare module '*?server'` shim, which erases the types on exactly the import that most needs them. Not shippable as a public API.

### 4.4 Is there a public plugin API? No

- "Turbopack does not support webpack plugins." [NEXT-TURBOPACK-REF]
- "`webpack()` configuration in `next.config.js` — Turbopack replaces webpack, so `webpack()` configs are not recognized." [NEXT-TURBOPACK-REF]
- Custom loaders are officially **not yet stable**: the docs' own Less row says support "will likely require a loader config once custom loaders are stable" [NEXT-TURBOPACK-CFG], and "Only a core subset of the webpack loader API is implemented".
- There is no separate Turbopack documentation site any more; `turbopack.dev/docs` and `turbo.build/pack/docs` both redirect into the Next.js docs [SOURCE].

So the loader route is *documented* but sits on an explicitly unstable surface, with no plugin API beneath it.

## 5. SWC plugins

**Verdict: out, on three independent grounds.**

`experimental.swcPlugins` **is** supported under Turbopack in 16.3 — it is not in `unsupportedTurbopackNextConfigOptions`, there is a full wasmtime-backed implementation registered in **both** the client and server graphs [SRC-SWCPLUGIN], and measured, an unresolvable plugin fails the Turbopack build (`Module not found: Can't resolve '@swc/plugin-does-not-exist-zzz'`, `exit=1`) [PROBE]. Documented at [NEXT-COMPILER]. But:

1. **A plugin cannot tell client from server.** Turbopack constructs the plugin metadata as `TransformPluginMetadataContext::new(Some(filename), node_env, None)` [SRC-SWCPLUGIN] — a plugin sees **filename and `NODE_ENV`, nothing else**. On the webpack path, `swcPlugins` become `jsc.experimental.plugins`, identical for every layer; `next-swc-loader` *does* know its `bundleLayer` and varies other SWC options by it, but not the plugin list or the metadata [SOURCE]. Wrong axis entirely.
2. **The Wasm ABI is not backwards compatible.** SWC states it plainly: "Currently, the Wasm plugins are not backwards compatible. So you need to select an appropriate version of `swc_core` for your plugin" [SWC-PLUGINS]. Next canary pins `swc_core = "76.0.0"` [SOURCE]. A published plugin would need a rebuild per Next minor, tracked through <https://plugins.swc.rs>.
3. **It fails open.** On a version mismatch Turbopack emits an Issue and **returns the untransformed program** [SOURCE]; the error text is `Failed to execute SWC plugin … Caused by: failed to deserialize …`. Under webpack the same mismatch produces **no error at all** — Next's own e2e test asserts "Expected Redbox but found no visible one" with a `// TODO missing proper error with Webpack` [SOURCE]. For a transform whose purpose is keeping Authorize out of the browser, silently skipping is the worst possible failure mode.

## 6. Codegen and ecosystem prior art

**Verdict: build-time file splitting is real, canonical, and lives entirely outside the Next App Router. Inside it, nobody does this — the ecosystem converged on three other seams instead.**

### 6.1 Libraries that really do split one authored file

| Project | Mechanism | Status |
| --- | --- | --- |
| **React Router v7 / Remix** | Babel-based **named-export removal** in the client build: `SERVER_ONLY_ROUTE_EXPORTS = ["loader","action","middleware","headers"]`, then `babel-dead-code-elimination` drops the imports that became unreferenced. Docs: "Any server-only Route Module APIs will be removed from the bundles… so you can use server-only code in the other module exports." If a *client* export depends on a server-only import, the build throws a targeted error. | Vite only |
| **`vite-env-only`** | Expression macros: `serverOnly$(expr)` / `clientOnly$(expr)` are replaced with `undefined` in the wrong environment, plus DCE of newly-unreferenced identifiers. Types stay honest (`serverOnly$("secret") //^? string \| undefined`). Its README states the design principle exactly: *"In general, it's a bad idea to rely on optimizations for correctness… these macros treat code replacement and dead-code elimination as part of their feature set."* | Vite only |
| **Next.js Pages Router — itself** | The SWC transform `next_ssg` drops `getStaticProps` / `getStaticPaths` / `getServerSideProps` **and their now-unreferenced imports** from the client bundle, with a first-party verification tool (`next-code-elimination`). | **Next did exactly this — in the router it deprecated.** No App Router equivalent exists. |
| **TanStack Start** | `createServerFn`: "The build process replaces server function implementations with RPC stubs in client bundles." Function-granular, not property-granular. | Not Next |

The gap is precise: export-granular stripping is a solved, shipped idea; **property-granular stripping of an object literal passed to a call is not done by anyone**, and `vite-env-only`'s `serverOnly$()` macro is the only primitive shaped like what `authorize: serverOnly$(...)` would need.

### 6.2 Payload CMS: the closest analogue, and it does not use codegen for this

Payload has our problem exactly: `payload.config.ts` holds `db`, `secret`, `access`, `hooks`, `email`, and its admin UI is a Client-Component app that needs the config. The docs are blunt: *"the Payload Config is non-serializable by design. It is full of custom validation functions and more… For this reason, Payload creates a Client Config and passes it into the Config Provider."*

The mechanism is **a runtime strip on the server, handed across the RSC boundary as a prop** — not a build step, not a generated file:

- `createClientConfig()` walks the sanitized config and `continue`s past every server-only key, returning a plain serializable object; it is memoized per language with React `cache()`.
- The RSC root layout renders `<RootProvider config={clientConfig} permissions={…}>`, a `'use client'` provider, consumed via `useConfig()`.
- The strip lists are explicit arrays in source, e.g. `serverOnlyConfigProperties = ['baseAccess','endpoints','db','editor','plugins','sharp','onInit','secret','hooks','bin','i18n','typescript','cors','csrf','email','custom','graphQL','jobs','logger','kv','queryPresets','storage']`, plus per-collection (`['hooks','access','endpoints','custom','joins',…]`) and per-field (`['hooks','access','validate','defaultValue','filterOptions','editor','custom',…]`) lists. Some entries carry a comment naming the reason: `'slugify' // a function, cannot cross the RSC boundary`.
- Pre-auth hardening: `createUnauthenticatedClientConfig` strips field schemas entirely on the login page, "so the page source should not contain this information."

**And the `authorize` analogue is handled the same way everyone else handles it.** Payload's `admin.condition` is a user predicate the client needs the *result* of; it is server-only, invoked on the server during form-state building, and only the boolean `passesCondition` crosses. Access control is likewise evaluated server-side into a boolean `SanitizedPermissions` tree shipped as an RSC prop.

The documented cost is honest: *"With Server Components, be aware of what is being sent through the server/client boundary. All props are serialized and sent through the network. This can lead to large HTML sizes and slow initial load times."*

**`importMap` is a separate, orthogonal mechanism**, and it is codegen. Because the config must stay Node-light, components are *not imported into it* — they are path strings (`Button: '/components/Logout#MyComponent'`). `writeImportMap()` emits a real `app/(payload)/admin/importMap.js` containing `import { X as id0 } from '…'` plus `export const importMap = { "/components/Logout#MyComponent": id0 }`. It runs from three triggers: the `payload generate:importmap` CLI, `payload build`, and — the interesting one — **from inside `payload.init()` at server boot and on config HMR**, gated by `admin.importMap.autoGenerate !== false`. Docs: *"The Import Map is automatically regenerated at startup and whenever Hot Module Replacement (HMR) runs… The import map file should never be manually edited."*

Note that Payload's own `withPayload` next.config wrapper does **no** codegen; it only sets `serverExternalPackages`, webpack `externals`, headers and sass options.

### 6.3 The reference-not-code family

- **Convex** — `convex/_generated/api.js` is a two-liner *independent of your app*: `import { anyApi } from "convex/server"; export const api = anyApi;`. All app-specific information is in `api.d.ts`, as `import type * as messages from "../messages.js"`. `anyApi` is a Proxy that accumulates a path and materialises `"module:export"` only when an internal symbol is read. So the client bundle contains two statements plus a generic Proxy; query bodies and `schema.ts` are never in the client graph. Generated by `npx convex dev` (continuous) or `npx convex codegen`; **no `postinstall`**; requires a live deployment; and the docs say to **commit** `_generated/`: *"Check this folder in to your git repo. That way your code will typecheck without needing to run `npx convex codegen`."*
- **tRPC** — no codegen at all, by stated design ("without schemas or code generation"). The client is `createFlatProxy(createRecursiveProxy(...))`, which turns property access into a dotted path and the final call into an HTTP request. The guarantee is documented as a *tip*, not an enforcement: *"By using `import type` you ensure that the reference will be stripped at compile-time, meaning you don't inadvertently import server-side code into your client."* The App Router guide's actual enforcement is the `server-only`/`client-only` packages. Documented DX cost: the client tsconfig needs the same `paths` as the server's, and "a monorepo is not mandatory but you will lose some of the benefits". (The "slow types" problem is real but *not* documented by tRPC — a repo-wide search finds no `isolatedDeclarations` mention; the only documented mitigation, `lazy()` routers, is framed as a cold-start fix.)
- **Liveblocks**, the closest real-time analogue: `liveblocks.config.ts` is a **types-only** `declare global { interface Liveblocks { Presence; Storage; RoomEvent } }` augmentation with no runtime value at all, and authorization is a separate route handler (`liveblocks.prepareSession(user.id).allow(room, ["*:read"])`) that the client reaches through `authEndpoint`. **Authorization is never in the config file.**

### 6.4 The Authorize question specifically

Two libraries tried to make authorization rules travel, and the results are instructive.

- **Zero / Rocicorp** built the serialize-rules-to-an-AST machine and shipped it. A permission rule is not arbitrary JS — its type forces it to *return* a query-builder AST node: `(authData, eb: ExpressionBuilder<TTable, TSchema>) => Condition`. `definePermissions` invokes each rule once at deploy time against a synthetic `ExpressionBuilder`, captures the AST, maps client→server column names, and discards the functions. The artifact is valita-validated JSON written into Postgres by `npx zero-deploy-permissions`; zero-cache reads it back and warns *"No upstream permissions deployed"* if it is missing. The rules are textually present in the client bundle (one shared `schema.ts`) but **inert** — nothing in `zero-client` reads them. **And `definePermissions` is now `@deprecated`** ("Use `defineMutators` and `defineQueries` instead"), with the deploy script printing "Permissions are deprecated and will be removed in an upcoming release". The replacement is arbitrary JS auth behind your own `/api/zero/query` and `/api/zero/mutate` endpoints with a server-built `ctx`. This is directly on point: the AST DSL bought serializability by forbidding DB lookups, and `authorize({roomId},{user}) => isMember(user.id, roomId)` is exactly what it could not express — so they reverted to the endpoint model.
- **Inngest Realtime** shares the channel file: *"Channels are defined once and shared between your function code and your client code."* What ships is the channel name (or name function), the topic names, **and the validators** — with a documented opt-out, `staticSchema<T>()`, described as *"When you only need TypeScript types without runtime validation (zero bundle cost)"*, plus a fully type-only `typeOnlyChannel<TChannelDef>(id)` Proxy. The authorize analogue lives **outside** the channel file, in a `'use server'` action that mints a scoped capability token (`getSubscriptionToken` POSTs `[{channel, name: topic, kind:"run"}]` to `/v1/realtime/token`); the React hook never authorizes, it takes a `token`.

### 6.5 The rest, briefly

- **next-safe-action** — the closest analogue to our ideal, and it resolves the tension by asking developers to **write the Zod schema twice**: the React-Hook-Form integration page shows byte-identical `z.object({...})` in both `actions.ts` and the `'use client'` form. There is no recommended shared-schema layout anywhere in its docs. The only bridge is type-level (`InferSafeActionFnInput<typeof myAction>`). Nothing but the action reference crosses; zod stays 100% server-side.
- **next-intl** — the plugin is essentially a bundler alias (`resolveAlias['next-intl/config'] = …` for Turbopack, `config.resolve.alias[…]` for webpack). It *does* codegen, but only a **type**: `experimental.createMessagesDeclaration` writes `messages/en.d.json.ts` containing `declare const messages: {…}; export default messages;`, from `next.config` evaluation time, `watchFile`d in dev, gitignorable — and the library itself calls it a "workaround". The message *values* cross as an RSC prop from `NextIntlClientProviderServer`, and the default is that **all** messages ship, with manual `pick()` as the documented mitigation.
- **Prisma** — the trend is *away* from magic. v7 removed the `postinstall` auto-generate, made `output` mandatory, and stopped generating from `migrate dev`/`db push`. Guidance: custom output path, gitignore it, run `prisma generate` from a build script or your own postinstall — with a whole docs page on CI cache staleness as the consequence. No Next.js plugin.
- **Panda CSS** — `"prepare": "panda codegen"` (not postinstall), `outdir: 'styled-system'`, and Panda **edits your `.gitignore` for you** (`gitignore: true` by default). The PostCSS plugin only *re*-generates — its first `emit()` is a no-op — which is why the `prepare` hook is mandatory. Dev needs a second watcher process (`concurrently "next dev" "panda --watch"`).
- **Sanity** — `sanity.config.ts` is a **client** file (it literally starts with `'use client'`); secrets are kept out by the `SANITY_STUDIO_`/`NEXT_PUBLIC_` prefix convention. Typegen (`sanity schema extract` → `sanity typegen generate`) emits pure `export type`. The transferable trick is in `next-sanity`: its `exports` map has `next-js` / `react-server` / `default` conditions, and the `default` (client) build re-exports the same TS signatures via `import type` but throws at runtime — `export function defineLive(_config): never { throw new Error("defineLive can't be imported by a client component") }` — regression-tested with a fixture whose build **must fail** (`"test": "next build && exit 1 || exit 0"`).
- **Keystatic** — genuinely one isomorphic `keystatic.config.ts`, imported by both a `'use client'` page and the route handler. It buys that by **deleting the escape hatch**: the `Config` type has no server-capable callbacks at all (the only functions allowed are pure/UI, like `parseSlugForSort` and `BrandMark`). Server-only config is a *separate* object on the route handler (`{clientId, clientSecret, secret, localBaseDirectory, config}`). The cost is that the entire config ships to the browser. **Adding `authorize(params, ctx)` to a Keystatic-shaped config is exactly what breaks the Keystatic design.**

### 6.6 What the ecosystem agrees on

1. **Nobody codegens runtime *values* out of a server-only module.** Convex's `api.js` is a constant; next-intl's codegen emits a `.d.ts`; tRPC codegens nothing by design. The libraries that codegen values (Prisma, Panda) start from a config that was never server-only.
2. **Authorize never ships, and nobody strips it with a bundler.** Only two proven answers: make the rule language serializable (Zero's AST — now deprecated, precisely because a rule that does a DB lookup cannot be expressed), or keep the callback in a module the client never imports (Inngest, Liveblocks, Wasp, Keystatic, Zero-new, Payload).
3. **"One authored file" is routine for types and abandoned for values.** next-safe-action tells you to write the schema twice. Keystatic achieved an isomorphic config only by removing callbacks from the type.
4. **CLI codegen is trending down.** Prisma 7 removed its postinstall; tRPC's whole pitch is not having one; Convex accepts the cost openly (live deployment required, commit the output, a second watcher). Payload's variant is the interesting one: codegen runs from inside `payload.init()` at boot and on HMR — no CLI in the hot path.
5. **`import type` is a compile-time tip, not a guarantee** — tRPC says so and reaches for `server-only` for real enforcement. next-sanity's throwing-stub-per-export-condition, with a build-must-fail fixture, is the strongest enforcement available without a bundler plugin.

## 7. React `taint` APIs

**Verdict: irrelevant to this problem.**

`experimental_taintObjectReference(message, object)` "lets you prevent a specific object instance from being passed to a Client Component"; `experimental_taintUniqueValue(message, lifetime, value)` blocks a high-entropy string/bigint/TypedArray from being sent to any Client Component while `lifetime` lives [REACT-TAINT]. Enforcement is entirely **runtime, inside the Flight serializer**: `ReactFlightServer.js` checks the taint registries at each serialization site and throws [SOURCE].

Why it does not apply:

- It guards the **RSC serialization boundary at request time**. It cannot stop an `import`, cannot remove a module from a client graph, cannot remove a closure from a chunk. Our problem is entirely a bundling problem.
- It is defeated by derivation: "Recreating or cloning a tainted object creates a new untainted object" [REACT-TAINT]; Next repeats "Tainting cannot keep track of data derived from a tainted value" [NEXT-TAINT].
- React's own docs say "**Do not rely on just tainting for security**" [REACT-TAINT].
- The cost is high: `experimental.taint: true` "also enables the React `experimental` channel for `app` directory" [NEXT-TAINT] — the whole App moves off stable React.

## 8. Next 16 specifics

Nothing in 16.x changes the picture, but three things are worth recording.

- **Cache Components / `'use cache'`** — enabled by top-level `cacheComponents: true`, introduced in 16.0, **not on by default in 16.3** (the 16.3 post still tells you to opt in) [NEXT-16]. It is *directive-adjacent* to our problem: "When a cached directive is at the top of a file, you can import its exported functions into a Client Component and call them directly; they run on the server and return the result, similar to a Server Function" [NEXT-USECACHE]. But every export must be `async`, and `cookies()`/`headers()`/`searchParams` are forbidden inside. It would turn `authorize` into a client-callable RPC — the exact opposite of an authorization boundary. Not applicable.
- **`proxy.ts`** — the 16.0 rename of `middleware.ts`, now defaulting to the Node.js runtime; codemod `npx @next/codemod@canary middleware-to-proxy .` [NEXT-PROXY], [NEXT-16]. Request-time interception, its own compilation unit, no bearing on client chunks. (It does get the `react-server` condition [SRC-SERVERCTX], so `server-only` works there.)
- **Turbopack filesystem cache** — `experimental.turbopackFileSystemCacheForDev` (default-on since 16.1) and `experimental.turbopackFileSystemCacheForBuild` (default-on since **16.3**) [NEXT-FSCACHE]. There is no `turbopack.persistentCaching` key. **This is a real hazard for any codegen design**: the Turbopack loader context has no `this.addContextDependency`/`addMissingDependency` and only `this.fs.readFile`, whose reads are reported back to Rust as `trackFileRead` for invalidation [SRC-TPLOADER]. A loader that reads a generated file with plain `node:fs` is invisible to the dependency graph, and the persistent cache will serve a stale artifact across dev restarts and builds. Generated inputs must be read via `this.fs.readFile` or be real modules in the import graph.
- **Build Adapters** (`adapterPath`, alpha since 16.0) exist and can "modify Next.js configuration or process build output" [NEXT-ADAPTER]. Wrong tool: one adapter per project, aimed at deployment platforms, would conflict with the App's hosting adapter, and offers no per-module transform.
- **`next typegen`** exists in 16.3 and generates route types into `.next/types` plus `next-env.d.ts` [NEXT-CLI]. Useful precedent — "the framework writes generated `.d.ts`, the App includes it in `tsconfig`" is first-party-blessed — but it is **types only**; nothing in it emits runtime JS or splits a graph.
- No 16.x change to how `'use server'` modules are bundled was found; the server-action changes in 16.x are all API-level (`revalidateTag(tag, profile)`, `updateTag()`, `refresh()`) [NEXT-16].

## 9. Comparison table

| # | Mechanism | Status | Turbopack | webpack | What the App writes | What crosses to the browser |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `'use server'` module exporting `pattern` | **impossible** | build error | build error | — | nothing: exports become opaque `createServerReference` proxies |
| 2a | Colocated file, no guard, rely on tree-shaking | **broken (leaks)** | ships `authorize` + DB code | same | one file | `pattern` **and** `authorize` body **and** inlined DB module; everything, unminified, in dev |
| 2b | Colocated file + `server-only` | **impossible** | build error (browser + SSR) | build error | one file | — build fails |
| 2c | Library `exports`: `react-server` / `browser` / `default` | **works, undocumented** | ✅ | ✅ | one file, but *App* imports unchanged | still `authorize` + App's `db` import — conditions only redirect *library* specifiers |
| 3 | `await import('./db')` inside `authorize` | **worse** | still poisons; 3 lazy chunks without the poison | same | one file | `authorize` + `db` + `auth`, in separate chunks |
| 4a | `turbopack.rules` `condition:'browser'` + strip loader | **hack that works, with a caveat** | ✅ browser clean | n/a | one file + `withSSE()` config; **no `server-only`, no `next/headers`** anywhere reachable | `pattern` only |
| 4b | Turbopack, `condition:{not:{query:/server/}}` + `./sse?server` | **hack that works** | ✅ full solve, `server-only` kept | n/a | one file + config + a magic `?server` import that TS cannot type | `pattern` only |
| 4c | webpack rule, `issuerLayer:{or:['ssr','app-pages-browser']}` | **hack that works, cleanly** | requires `turbopack: {}` or build exits 1 | ✅ full solve, `server-only` kept | one file + `withSSE()` config; `next build --webpack` | `pattern` only |
| 5 | `experimental.swcPlugins` | **impossible** | plugin runs, but sees no layer | same, and fails silently | — | — |
| 6a | Codegen (`sse.client.ts` derived from `sse.ts`) | **supported pattern, App-visible cost** | ✅ | ✅ | one authored file + a generated file + a CLI/watcher/postinstall | exactly what codegen chose to emit |
| 6b | **Runtime strip on the server + RSC prop** (Payload's `createClientConfig`, next-intl) | **plain RSC, no build machinery** | ✅ | ✅ | one colocated file + `<SSEProvider …>` rendered from a Server Component layout | the patterns/event names, serialized into the RSC payload — no module import, so no poison, no leak |
| 7 | React `taint` | **not applicable** | n/a | n/a | — | it is a runtime prop guard, not a bundler feature |
| 8 | `optimizePackageImports`, `modularizeImports`, `transpilePackages`, `serverExternalPackages`, `outputFileTracingExcludes`, `'use cache'`, `proxy.ts`, Build Adapters | **not applicable** | — | — | — | wrong axis in every case |
| E | Colocated declarations, client restates patterns (prototype variant **E**) | **plain TypeScript** | ✅ | ✅ | two files: the colocated registry (server) + one small pattern map (client), compiler-checked against each other | `pattern` strings only |
| D | Colocated declarations, client is `import type` + Proxy (variant **D**) | **plain TypeScript** | ✅ | ✅ | one file + a type-only client import | nothing: the handle is `{ key, params }` |

## 10. Recommendation for next-sse v0.1

**Do not build v0.1 on a bundler transform. Move the patterns across as data, not as an import.**

The framing question was "how do we extract *values* from a server module into the client **bundle**". Every answer to that question is either impossible ([§1](#1-use-server-files), [§5](#5-swc-plugins)), broken ([§2.4](#24-what-actually-ships-measured), [§3](#3-lazy-dynamic-imports-inside-authorize)) or a config-invasive hack that fails open ([§4](#4-loaders-and-transforms)). The ecosystem's answer is to **reframe it**: the client does not need the patterns at *module* scope, it needs them at *render* scope — and RSC already moves data from the server to Client Components. That is what Payload does with `createClientConfig`, what next-intl does with messages, and what Convex does with `preloadQuery` ([§6.2](#62-payload-cms-the-closest-analogue-and-it-does-not-use-codegen-for-this), [§6.3](#63-the-reference-not-code-family)).

Concretely, in order:

1. **Primary: colocated file + an RSC-prop provider (row 6b) + type-only client handles (variant D).** The App keeps one `lib/sse.ts` with `pattern`, `events`, `authorize`, `context` and its `server-only` imports intact. The library ships `<SSEProvider sse={sse}>` as a **Server Component** that calls a `toClientChannels(sse)` strip — a hand-written key allowlist, exactly Payload's `serverOnlyConfigProperties` — and passes the result as a prop to its own `'use client'` provider. Client Components reference Channels through a type-only handle and read the pattern from context at call time.
   - The colocated module is **never imported by a Client Component**, so none of §2 applies: no poison, no SSR-layer breakage, no leak in dev, `server-only` stays.
   - Zero duplication, zero config, zero codegen, zero bundler coupling, identical under both bundlers.
   - It **fails closed**: a key that is not on the allowlist simply never crosses.
   - Costs to weigh: the App must render the provider from a Server Component (normal — next-intl and Payload both require this); the patterns land in the RSC payload/HTML (they are not secret, and they are small — unlike Payload's and next-intl's payloads, which the docs both flag as a size concern); and `useChannel` gains a runtime dependency on the provider being mounted.
2. **Fallback: variant E** (colocated declarations, the client restates one pattern string per Channel, compiler-checked against the server registry) if requiring a provider is judged too invasive. It is the only *import-based* shape that is correct everywhere with no machinery, and its duplication cannot silently drift. Note that next-safe-action — the closest analogue in the ecosystem — ships exactly this trade, with *unchecked* duplication ([§6.5](#65-the-rest-briefly)).
3. **Keep Authorize off the wire entirely, in every shape.** This is the one point on which the prior art is unanimous, and Zero's deprecation of `definePermissions` is the cautionary tale: an authorization rule that can reach a database cannot be made serializable, so it must live in a module the client never imports ([§6.4](#64-the-authorize-question-specifically)). That constraint is *independent* of the colocation question and should be treated as settled.
4. **Do use `exports` conditions inside `@flefebvre/next-sse` itself** — `react-server` for the real server implementation, the stripped one on **`default`** (not just `browser`, or the SSR layer breaks). Measured correct in 16.3 under both bundlers ([§2.3](#23-package-exports-conditions-measured-per-layer)). Follow next-sanity and make the client stub *throw* rather than no-op, and add a fixture whose build must fail (`next build && exit 1 || exit 0`) so the guard is regression-tested ([§6.5](#65-the-rest-briefly)).
5. **Keep `server-only` in the library's server entry** and document it for the App's Authorize dependencies. §2.5 shows nothing can tree-shake past it: it is the cheapest failure-closed guard available.
6. **Revisit for v0.2 only if a real App reports a real problem.** If it does, the candidate is codegen (a `next-sse generate` writing a client artifact beside the authored file) rather than a loader: bundler-agnostic, inspectable, diffable, fails closed. Two things to carry forward if it is built: Payload's trigger model (regenerate from inside the server's own init and on HMR, so no CLI sits in the hot path) is better DX than Prisma's postinstall, whose consequence is a whole docs page about CI cache staleness; and generated inputs must be read through `this.fs.readFile` or be real graph modules, or the Turbopack build FS cache — **default-on since 16.3** — will serve stale artifacts [NEXT-FSCACHE].

**What is explicitly rejected**: the loader-based strip as a v0.1 foundation. It is the most *impressive* result in this document — [§4.2](#42-webpack-issuerlayer-a-complete-solve) is a complete solve on webpack, with `server-only` intact — but webpack is no longer the default, the Turbopack equivalent cannot reach the SSR layer without an untypeable `?server` import, it forces `turbopack: {}` into every App's config or the build exits 1, it rides a surface Next itself calls unstable, and when it silently does not match, Authorize ships to the browser. No Next.js library does this today, and next-sse should not be the first.

## Appendix A: the harness

All [MEASURED] claims come from a probe app at `/tmp/sse-probe`: Next.js `16.3.2`, React `19.2.0`, `server-only@0.0.1`, Node `v24.16.0`, on Linux (WSL2). Not committed; reproducible from the sketch below.

```
app/page.tsx          Server Component rendering <ClientBit/>
app/client.tsx        'use client'; imports ../lib/sse; renders sse.channels.chat.pattern
app/api/sse/route.ts  Route Handler; calls sse.context(request) and channels.chat.authorize(...)
lib/sse.ts            the colocated registry (see below)
lib/db.ts             marker SECRET_DB_MARKER_ZZZ, optionally `import 'server-only'`
lib/auth.ts           marker SESSION_MARKER_ZZZ, optionally `import 'server-only'` / `next/headers`
strip-loader.cjs      TypeScript-AST loader: deletes `authorize`/`context` property assignments,
                      then deletes import declarations whose bindings became unused
node_modules/@probe/sse   fake library with an `exports` map per condition, each exporting COND_<cond>_ZZZ
```

```ts
// lib/sse.ts
import { db } from './db'
import { getSession } from './auth'
import { createSSE, channel } from '@probe/sse'

export const sse = createSSE({
  context: async (request: Request) => ({ user: (await getSession(request)).user }),
  channels: {
    chat: channel({
      pattern: 'chat:{roomId}',
      events: { message: { kind: 'text' } },
      authorize: async ({ roomId }: { roomId: string }, ctx: any) => {
        if (ctx.user.id === 'AUTHORIZE_BODY_MARKER_ZZZ') return false
        return db.isMember(ctx.user.id, roomId)
      },
    }),
  },
})
```

Method: `rm -rf .next && npx next build` (Turbopack) or `npx next build --webpack`, then
`grep -rlF "<MARKER>" .next/static` (what the browser gets) and `.next/server` (what the server gets).
For dev, `next dev -p 3999`, fetch `/`, then download every `/_next/static/**.js` the HTML references and grep the concatenation.

**Marker discipline.** An early run appeared to show Turbopack stripping `authorize`, because the markers were an unused local `const` and an unused object property that the minifier folded away. Markers must be *load-bearing* — inside a template literal in a `fetch` URL, or compared against in a returned expression — or the measurement lies. The corrected run is [§2.4](#24-what-actually-ships-measured).
