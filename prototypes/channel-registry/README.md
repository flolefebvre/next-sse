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

## The four variants

All share `lib/pattern.ts` (`{name}` placeholders, params inferred from the pattern literal, fill/parse at runtime), `lib/standard-schema.ts` (vendored Standard Schema types, `asType<T>()` for types-only payloads) and `lib/channel.ts` (a Channel is `pattern` + `events: { name: schema }`, an instance `chat({ roomId })` is the typed handle). Call sites are the same everywhere: `sse.publish(chat({ roomId }), 'message', {...})` and `useChannel(chat({ roomId }), { message: (m) => ... })`.

| | **C: split** | **D: colocated, type-only client** | **E: colocated, client restates patterns** | **F: shared, colocated, ctx-only authorize** |
|---|---|---|---|---|
| Folder | `variants/c-split/` | `variants/d-colocated/` | `variants/e-colocated-names/` | `variants/f-shared-colocated/` |
| Where a Channel is declared | shared `channels.ts`: `defineChannel({ pattern, events })` | one server-only file: `channel({ pattern, events, authorize })` | same as D | shared `channels.ts`: `channel({ pattern, events, authorize })` |
| Where authorize lives | `createSSE({ authorize: { chat: … } })`, a second file, exhaustive map | next to its Channel | next to its Channel | next to its Channel, **but may only use `(params, ctx)`** |
| What authorize can import | anything server-side | anything server-side | anything server-side | nothing: capabilities come through `ctx` from the server-only `context(request)` |
| Client gets | the shared module (patterns + schemas as values) | `import type` + Proxy: types only | `import type` + a pattern map restated once, **compiler-checked** against the server registry | the shared module (patterns + schemas + authorize *code*) |
| Client knows Channel names | yes | **no**: handle is `{ key, params }` | yes | yes |
| Connection carries | names (`?channel=chat:42`), server parses | `{ key, params }`, server mints the name | names, server parses | names, server parses |
| Duplication | none | none | one pattern string per Channel on the client | none |
| In the client bundle | zod + patterns | nothing | patterns | zod + patterns + authorize function bodies |

**The trade in one line.** C is the only shape where the client holds the real values *and* authorize imports server code freely, at the price of a split. Every colocated shape gives up one: D/E keep authorize free but the client has no values (D: no names; E: restate them), F keeps shared values but authorize goes through `ctx` and its logic is readable in the browser.

## Things to react to

1. **Which shape?** Colocation is the standing preference; the question is D (no names on the client), E (restate patterns, compiler-checked) or F (shared file, authorize limited to `ctx`). F's `ctx` doubles as an explicit seam for "what authorize may see"; E's pattern map is a small, impossible-to-get-wrong list; D changes what the Connection carries.
2. **`events` map vs one schema per Channel.** All variants use `events: { message, typing }`. For single-kind Channels (`notifications`) the extra level is visible at every call site: `publish(x, 'notification', …)`, `useChannel(x, { notification })`.
3. **Authorize signature**: `(params, ctx) => boolean | Promise<boolean>`, with `ctx` from `context(request)`. No `request` in the params, no way to say *why* a Channel was denied.
4. **Any unknown or denied Channel refuses the whole Connection** (403 in the demo). Is an unknown name a 403 or a 400?
5. **Pattern grammar**: `{name}`, literal separators, params must not contain `:` (`fill` throws, `chat:4:2` never matches). Regex per param, optional params and wildcards are deliberately absent.
6. **Registration**: the registry is an object (`{ chat, notifications }`) so `authorize` (C) and the client Proxy (D) are keyed by the same names; `publish` refuses instances of unregistered Channels at compile time.
7. **Input vs Output**: `publish` accepts `InferInput`, validates, puts `InferOutput` on the wire (demo: zod trims). The client hook is typed as Output and does **not** re-validate.
8. **Types-only payloads** via `asType<{ text: string }>()`: no validator, anything passes at runtime.
