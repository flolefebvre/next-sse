# PROTOTYPE: typed Channel registry with Authorize colocated

Throwaway playground for [issue #8](https://github.com/flolefebvre/next-sse/issues/8) (map [#1](https://github.com/flolefebvre/next-sse/issues/1)). **Not production code**: the `lib/` here is a fake `next-sse` with just enough type machinery and runtime to make the App-side files real.

**Question.** What does a Channel declaration look like so that one definition types `publish`, the client hook and Authorize end to end, Authorize stops being one giant function, and the registry is shared with the client without leaking server code?

## Run

```sh
cd prototypes/channel-registry
pnpm install
pnpm play      # = tsc (every @ts-expect-error in variants/*/usage.ts must fire) + node demo.ts
```

Then open the three files of each variant in an editor and hover: that is the prototype.

## The two variants

Both share `lib/pattern.ts` (`{name}` placeholders, params inferred from the pattern literal, fill/parse at runtime), `lib/standard-schema.ts` (vendored Standard Schema types, `asType<T>()` for types-only payloads) and `lib/channel.ts` (a Channel is `pattern` + `events: { name: schema }`, an instance `chat({ roomId })` is the typed handle).

| | **C: split registry** (`variants/c-split/`) | **D: colocated, type-only client** (`variants/d-colocated/`) |
|---|---|---|
| Declaration | `defineChannel({ pattern, events })` in a **shared** `channels.ts` | `channel({ pattern, events, authorize })` in **one server-only** file |
| Authorize | `createSSE({ context, channels, authorize: { chat: ({ roomId }, ctx) => … } })`, exhaustive map, params typed from the pattern | inside each `channel({...})`; `initSSE({ context })` binds the ctx type |
| Client import | the shared module (value): zod + patterns in the client bundle, names built client-side | `import type { sse }` + `createClient<typeof sse>()` Proxy: nothing but types reaches the client |
| Client handle | `chat({ roomId })` → `{ name: 'chat:42', … }` | `channels.chat({ roomId })` → `{ key: 'chat', params }`: the client never sees a Channel name |
| Connect request | `?channel=chat:42&channel=…` — server **parses** names back to params | `?channels=[{key,params}]` — no parsing, server **mints** the name after Authorize |
| Files per App | 2 (`channels.ts`, `channels.server.ts`) | 2 (`sse.server.ts`, `sse.client.ts`) but the client one is 2 lines |

## Things to react to

1. **C or D?** C matches the research recommendation and Inngest/Zero; D keeps Authorize next to its Channel (the ticket's title), and removes schema code from the client bundle. D changes what the Connection carries (`key+params` vs names) — names then exist only server-side and in the Redis wire contract.
2. **`events` map vs one schema per Channel.** Both variants use `events: { message, typing }`. For single-kind Channels (`notifications`) the extra level is visible at every call site: `publish(x, 'notification', …)`, `useChannel(x, { notification })`.
3. **Authorize signature**: `(params, ctx) => boolean | Promise<boolean>`, with `ctx` from `context(request)`. No `request` in the params, no way to say *why* a Channel was denied.
4. **Any unknown or denied Channel refuses the whole Connection** (403 in the demo). Is an unknown name a 403 or a 400?
5. **Pattern grammar**: `{name}`, literal separators, params must not contain `:` (`fill` throws, `chat:4:2` never matches). Regex per param, optional params and wildcards are deliberately absent.
6. **Registration**: the registry is an object (`{ chat, notifications }`) so `authorize` (C) and the client Proxy (D) are keyed by the same names; `publish` refuses instances of unregistered Channels at compile time.
7. **Input vs Output**: `publish` accepts `InferInput`, validates, puts `InferOutput` on the wire (demo: zod trims). The client hook is typed as Output and does **not** re-validate.
8. **Types-only payloads** via `asType<{ text: string }>()`: no validator, anything passes at runtime.
