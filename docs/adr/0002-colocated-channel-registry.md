# Colocated server-only Channel Registry, shared with the client as data

The App declares its Channels in one server-only module: `createSSE({ chat: channel({ pattern, events, authorize }) })`, with Authorize next to the Channel it guards and free to import session or database code. That module is never imported by a Client Component. Instead, the library's `<SSEProvider sse={sse}>` Server Component strips the Registry to an explicit allowlist (`{ key: { pattern, events } }`) and passes it as a prop to its `'use client'` half; Client Components address Channels through type-only Handles (`channels.chat({ roomId })`, typed via `import type` of the server module) and `useChannel` resolves the Channel name from that data at render time.

This follows the measured finding that Next.js 16.3 has no supported way to extract values from a server module into the client bundle: `'use server'` forbids non-function exports, `server-only` poisoning is resolve-time and ignores reachability, a colocated file imported by the client ships Authorize and its database imports verbatim in development, and bundler transforms either cannot separate RSC from SSR (Turbopack) or fail open. Moving the patterns as render-time data, Payload CMS's approach, is bundler-independent and fails closed.

Server Handles are bound to the App, so `chat({ roomId }).message(payload)` publishes without a separate `sse.publish` step; `.publish(event, payload)` remains for dynamic event names.

## Considered Options

- Split registry, `defineChannel` shared and an `authorize` map in a server-only `createSSE`: rejected, two files to keep in step grow unmanageable with many Channels.
- Shared file with Authorize restricted to `(params, ctx)`: rejected, Authorize cannot reach a database directly and its code ships to the browser.
- Client restates each pattern, compiler-checked against the server type: kept as the documented fallback when a provider cannot be mounted.
- Type-only client with `{ key, params }` Handles and no Channel names on the client: rejected, the Connection and devtools lose the readable Channel name for no gain once the provider exists.
- Bundler-level stripping of `authorize` (webpack `issuerLayer`, Turbopack rules, SWC plugin): rejected, unsupported surface, Turbopack cannot reach the SSR layer, and a silent mismatch ships Authorize to the browser.
- Generated per-Channel hooks (`channels.useChat`): rejected, `eslint-plugin-react-hooks` does not recognise `object.useX` as a hook.
