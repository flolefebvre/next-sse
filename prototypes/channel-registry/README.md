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

## The five variants

All share `lib/pattern.ts` (`{name}` placeholders, params inferred from the pattern literal, fill/parse at runtime), `lib/standard-schema.ts` (vendored Standard Schema types, `asType<T>()` for types-only payloads) and `lib/channel.ts` (a Channel is `pattern` + `events: { name: schema }`, an instance `chat({ roomId })` is the typed handle). Call sites are the same everywhere: `sse.publish(chat({ roomId }), 'message', {...})` and `useChannel(chat({ roomId }), { message: (m) => ... })`.

| | **C: split** | **D: colocated, type-only client** | **E: colocated, client restates patterns** | **F: shared, colocated, ctx-only authorize** | **G: colocated + `<SSEProvider>` passes data** |
|---|---|---|---|---|---|
| Folder | `variants/c-split/` | `variants/d-colocated/` | `variants/e-colocated-names/` | `variants/f-shared-colocated/` | `variants/g-provider/` |
| Where a Channel is declared | shared `channels.ts`: `defineChannel({ pattern, events })` | one server-only file: `channel({ pattern, events, authorize })` | same as D | shared `channels.ts`: `channel({ pattern, events, authorize })` | one server-only file, same as D |
| Where authorize lives | `createSSE({ authorize: { chat: … } })`, a second file, exhaustive map | next to its Channel | next to its Channel | next to its Channel, **but may only use `(params, ctx)`** | next to its Channel |
| What authorize can import | anything server-side | anything server-side | anything server-side | nothing: capabilities come through `ctx` from the server-only `context(request)` | anything server-side |
| Client gets | the shared module (patterns + schemas as values) | `import type` + Proxy: types only | `import type` + a pattern map restated once, **compiler-checked** against the server registry | the shared module (patterns + schemas + authorize *code*) | `import type` for handles + `{ key: { pattern, events } }` as a **prop through the RSC payload**, from a `<SSEProvider sse={sse}>` Server Component in the root layout |
| Client knows Channel names | yes | **no**: handle is `{ key, params }` | yes | yes | yes, resolved inside `useChannel` from provider data (returned by the hook) |
| Connection carries | names (`?channel=chat:42`), server parses | `{ key, params }`, server mints the name | names, server parses | names, server parses | names, server parses |
| Duplication | none | none | one pattern string per Channel on the client | none | none |
| In the client bundle | zod + patterns | nothing | patterns | zod + patterns + authorize function bodies | nothing (patterns ride in the RSC payload/HTML, not the JS) |

**The trade in one line.** C is the only *import-based* shape where the client holds the real values *and* authorize imports server code freely, at the price of a split. Every colocated import-based shape gives up one: D/E keep authorize free but the client has no values (D: no names; E: restate them), F keeps shared values but authorize goes through `ctx` and its logic is readable in the browser. G sidesteps the import question: the colocated file is never imported by the client, the values cross as *data* at render time (Payload's `createClientConfig` pattern), at the cost of a provider in the root layout and a runtime dependency on it. The [server→client extraction research](https://github.com/flolefebvre/next-sse/blob/research/server-client-extraction/docs/research/server-client-extraction.md) measured that no bundler-level extraction is supported in Next 16.3 and recommends G, with E as the fallback.

## Things to react to

1. **Which shape?** Colocation is the standing preference; the question is G (provider, data crosses at render time), D (no names on the client), E (restate patterns, compiler-checked) or F (shared file, authorize limited to `ctx`). G's cost is `<SSEProvider sse={sse}>` in the root layout and `useChannel` throwing without it; E's is one typed line per Channel; D changes what the Connection carries; F limits authorize.
2. **`events` map vs one schema per Channel.** All variants use `events: { message, typing }`. For single-kind Channels (`notifications`) the extra level is visible at every call site: `publish(x, 'notification', …)`, `useChannel(x, { notification })`.
3. **Authorize signature**: `(params, ctx) => boolean | Promise<boolean>`, with `ctx` from `context(request)`. No `request` in the params, no way to say *why* a Channel was denied.
4. **Any unknown or denied Channel refuses the whole Connection** (403 in the demo). Is an unknown name a 403 or a 400?
5. **Pattern grammar**: `{name}`, literal separators, params must not contain `:` (`fill` throws, `chat:4:2` never matches). Regex per param, optional params and wildcards are deliberately absent.
6. **Registration**: the registry is an object (`{ chat, notifications }`) so `authorize` (C) and the client Proxy (D) are keyed by the same names; `publish` refuses instances of unregistered Channels at compile time.
7. **Input vs Output**: `publish` accepts `InferInput`, validates, puts `InferOutput` on the wire (demo: zod trims). The client hook is typed as Output and does **not** re-validate.
8. **Types-only payloads** via `asType<{ text: string }>()`: no validator, anything passes at runtime.
