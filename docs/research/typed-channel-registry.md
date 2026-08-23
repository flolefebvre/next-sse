# Prior art for a typed Channel registry

Research for [issue #4](https://github.com/flolefebvre/next-sse/issues/4), part of the [v0.1 map (#1)](https://github.com/flolefebvre/next-sse/issues/1). Glossary terms (App, Instance, Channel, Message, Publish, Connection, Transport, Authorize, Prefix) are used as defined in `CONTEXT.md`.

**Question.** How do existing libraries give end-to-end type safety for named Channels with parameters (`chat:{roomId}`) and typed Message payloads, where do they put Authorize, and what does Standard Schema offer so validation stays library-agnostic? Output: candidate shapes for a `defineChannel` / registry API that types `publish`, `authorize` and the client hook from one declaration.

**Method.** Every claim below is tied to a primary source: the Standard Schema spec repo, the libraries' own source on GitHub, or their official docs (fetched via `ctx7` or directly from the docs repos). The TypeScript snippets in section 4 were type-checked with `tsc --strict` on TypeScript 5.9.3 and 7.0.2 (2026-08-23); where a claim could not be sourced it is flagged as such. Versions observed on `main` at research time: zod 4.4.3, valibot 1.4.2, arktype 2.2.3, `@standard-schema/spec` 1.1.0, inngest 4.18.1.

## 1. TL;DR

- **Standard Schema** is a single `~standard` property (`version`, `vendor`, `validate`, optional `types`) plus two type helpers (`InferInput`, `InferOutput`). A library validates any implementer with ~6 lines and zero runtime dependencies; the spec says to copy the types or depend on `@standard-schema/spec` as a *regular* (not dev) dependency. zod ≥ 3.24 / 4, valibot ≥ 1.0 and arktype ≥ 2.0 implement it in their core — confirmed in source. (§2)
- Among the surveyed realtime libraries, **none of Ably, Pusher or Socket.IO type the Channel name or the payload per Channel**: names are `string`, payload is `any`, and authorization is a separate step (token capabilities / auth endpoint / connection middleware). **tRPC** and **Zero** type parameters via a validator on a *named procedure/query* and put Authorize in the server-side handler/context. **Hono** types route params with template-literal types but its SSE helper carries `data: string`. **Electric** is untyped at the name level (`ShapeStream<T>` is a caller-asserted generic) and authorizes at an HTTP proxy. (§3)
- The closest prior art is **Inngest Realtime v4**: `realtime.channel({ name: (params) => \`pipeline:${id}\`, topics: { status: { schema } } })`, one declaration shared verbatim by server and client, Standard Schema per topic, `staticSchema<T>()` for types-only, and Authorize done when the server mints a subscription token. (§3.8)
- **Template-literal types** can extract params from `chat:{roomId}` and map a concrete name (`chat:42`) back to its pattern and params; limits are (a) only string *literals* narrow — a runtime `string` collapses to `never`, (b) `infer` is non-greedy so adjacent placeholders are ambiguous, (c) unions above ~100k members fail (TS2590). (§4)
- **Sharing**: `import type` is fully erased, `server-only` is a build-time poison pill handled by Next.js itself, and `authorize` should live in a server-only module so the client registry is schema + name only. (§5)
- **Recommendation**: a **function-named `defineChannel` (Inngest-style, candidate B)** with a **server-only `authorize` attached separately** (candidate C's split), and a *pattern-keyed registry (candidate A)* kept as a documented convention rather than the type-level mechanism. Rationale and open questions in §6–7.

## 2. Standard Schema

### 2.1 The interface

Source: [`packages/spec/src/index.ts`](https://github.com/standard-schema/standard-schema/blob/main/packages/spec/src/index.ts) in the spec repo (v1.1.0). The core of the spec, verbatim:

```ts
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input>
    extends StandardTypedV1.Props<Input, Output> {
    /** Validates unknown input values. */
    readonly validate: (
      value: unknown,
      options?: StandardSchemaV1.Options | undefined,
    ) => Result<Output> | Promise<Result<Output>>;
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult;
  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;   // a falsy `issues` indicates success
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  export type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
  export type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}
```

`StandardTypedV1.Props` contributes `version: 1`, `vendor: string` and `types?: { input: Input; output: Output }`; the helpers are `NonNullable<Schema["~standard"]["types"]>["input" | "output"]`. Spec 1.1.0 also adds `StandardJSONSchemaV1` (a `jsonSchema.input/output(options)` converter) — the repo `CHANGELOG.md` only lists v1.0.0 (2025-01-26), so the 1.1.0 release date is *not sourced*.

Design goals stated in [`packages/spec/schema.md`](https://github.com/standard-schema/standard-schema/blob/main/packages/spec/schema.md#design-goals): runtime validation with a standard error format, static type inference ("advertise" the inferred type), minimal to implement, single `~standard` key to avoid API conflicts, `~` prefix to de-prioritise in autocomplete.

### 2.2 Who implements it (confirmed in source)

The spec's implementer table ([schema.md](https://github.com/standard-schema/standard-schema/blob/main/packages/spec/schema.md#what-schema-libraries-implement-the-spec)) lists Zod 3.24.0+, Valibot v1.0+, ArkType v2.0+, plus Effect Schema (via adapter), Arri, decoders, Sury and others. Verified against each library's `main`:

| Library | Where | Notes |
|---|---|---|
| zod 4.4.3 | [`packages/zod/src/v4/core/schemas.ts`](https://github.com/colinhacks/zod/blob/main/packages/zod/src/v4/core/schemas.ts) — `"~standard": $ZodStandardSchema<this>` on `$ZodType`; `standardProps()` returns `{ validate, vendor: "zod", version: 1 }` | `validate` tries `safeParse` synchronously and falls back to `safeParseAsync(...).then(...)` only if the sync path throws (async refinements). Zod **vendors** the spec types (`import type { StandardSchemaV1 } from "./standard-schema.js"`), no dependency. |
| valibot 1.4.2 | [`library/src/utils/_getStandardProps/_getStandardProps.ts`](https://github.com/fabian-hiller/valibot/blob/main/library/src/utils/_getStandardProps/_getStandardProps.ts) | `validate(value)` delegates to `context['~run']({ value }, getGlobalConfig())`; props cached per schema in a `WeakMap`. |
| arktype 2.2.3 | [`ark/schema/roots/root.ts`](https://github.com/arktypeio/arktype/blob/main/ark/schema/roots/root.ts) — `get "~standard"()` | Returns `{ vendor: "arktype", version: 1, validate, jsonSchema }`; `validate` calls the type and returns `ArkErrors` (which itself carries `issues`) or `{ value }`. Also implements `StandardJSONSchemaV1`. |

tRPC's docs state that "validators are also used to infer the types of inputs and outputs (using the Standard Schema interface if available)" and that tRPC works "with any library conforming to Standard Schema" ([validators.md](https://github.com/trpc/trpc/blob/main/www/docs/server/validators.md)). Zero's docs: "you can use any validation library that implements Standard Schema" ([queries.mdx](https://github.com/rocicorp/zero-docs/blob/main/contents/docs/queries.mdx)).

### 2.3 Validating without depending on zod/valibot/arktype

From the spec FAQ ([schema.md](https://github.com/standard-schema/standard-schema/blob/main/packages/spec/schema.md#faq)):

- "The `@standard-schema/spec` package is completely optional. You can just copy and paste the types into your project. We guarantee no breaking changes without a major version bump." The package "contains no runtime code and only exports types".
- "you should *not* install `@standard-schema/spec` as a dev dependency. By accepting Standard Schemas as part of your public API, the Standard Schema interface becomes a part of your library's public API. As such, it *must* be available whenever/wherever your library gets installed".
- Sync-only consumers may `throw` if `validate` returns a `Promise`; "Libraries are encouraged to preferentially use synchronous validation whenever possible."

Reference implementations of the consumer side:

- tRPC [`parser.ts`](https://github.com/trpc/trpc/blob/main/packages/server/src/unstable-core-do-not-import/parser.ts): detects `'~standard' in parser`, then `const result = await parser['~standard'].validate(value); if (result.issues) throw new StandardSchemaV1Error(result.issues); return result.value;`.
- Inngest v4 [`Inngest.ts`](https://github.com/inngest/inngest-js/blob/main/packages/inngest/src/components/Inngest.ts) `realtime.publish`: `const result = await topicConfig.schema["~standard"].validate(data); if (result.issues) throw new Error(...)`. The client side ([`TokenSubscription.ts`](https://github.com/inngest/inngest-js/blob/main/packages/inngest/src/components/realtime/subscribe/TokenSubscription.ts)) optionally re-validates (`validate` flag), drops failing messages with `console.error`, and replaces `msg.data` with `validateRes.value`.
- **Pitfall, observed in source:** the older `@inngest/realtime` package ([`packages/realtime/src/channel.ts`](https://github.com/inngest/inngest-js/blob/main/packages/realtime/src/channel.ts), `createTopicFn`) does `await schema["~standard"].validate(data)` inside a `try/catch` and never reads `issues` — a `FailureResult` is silently accepted because `validate` *returns* failures rather than throwing. A consumer must always check `result.issues`.
- Inngest's `staticSchema<T>()` ([`triggers.ts`](https://github.com/inngest/inngest-js/blob/main/packages/inngest/src/components/triggers/triggers.ts)) shows how a library can offer a types-only escape hatch that is still a valid Standard Schema: `{ "~standard": { version: 1, vendor: "inngest", validate: (value) => ({ value: value as TSchema }) } }`.

Consequences for next-sse:

1. Accept `StandardSchemaV1` as the payload schema type; either vendor the ~100 lines (as zod does) or depend on `@standard-schema/spec` (types-only, regular dependency). Both keep zod optional.
2. Use `InferInput` for what `publish` accepts and `InferOutput` for what the client hook receives; they differ when a schema transforms/defaults. Validate on Publish (server, trusted caller) and send `result.value` (Output) on the wire.
3. Decide sync-vs-async: `publish` is already async, so awaiting `validate` is free server-side; on the client, optional re-validation would need to tolerate a Promise.
4. The spec guarantees nothing about JSON-serialisability of `Output` (e.g. zod can output `Date`); the wire format needs its own rule (see open questions).

## 3. How existing libraries type named Channels, params, payloads, and where Authorize lives

### 3.1 Ably (ably-js)

- Channel lookup: `channels.get(name: string, channelOptions?)`; publish: `publish(name: string, data: any, options?)`; subscribe: `subscribe(event: string, listener?: messageCallback<InboundMessage>)`; `Message.data?: any` — all from [`ably.d.ts`](https://github.com/ably/ably-js/blob/main/ably.d.ts). **No per-channel payload typing and no parameterised names**; the channel name is an opaque string.
- Authorize lives in **token capabilities**, not in code per channel: `TokenParams.capability?: { [key: string]: capabilityOp[] | ['*'] } | string` where `capabilityOp` is `'publish' | 'subscribe' | 'presence' | 'history' | ...` ([`ably.d.ts`](https://github.com/ably/ably-js/blob/main/ably.d.ts)). The server issues the token (`auth.createTokenRequest({ clientId, capability })` or a JWT with an `x-ably-capability` claim) after doing its own authorization.
- Naming convention for parameterised channels is the `namespace:rest` colon convention with segment wildcards in capabilities — from the [capabilities docs](https://ably.com/docs/auth/capabilities): "Wildcards can only replace whole segments (segments are delimited by `:`) of the resource name", "A wildcard at the end of the name can arbitrarily replace many segments" (`foo:*` matches `foo:bar:bam`), and `foo:*:baz` matches `foo:bar:baz` but not `foo:bar:bam:baz`. Example capability: `{ "your-namespace:user-123": ["subscribe"], "notifications": ["subscribe", "history"] }`.

Takeaway: colon-separated names with the *first segment as namespace* is the established convention; authorization is decided per name pattern when the server mints the token (how and when Ably's service enforces the capability afterwards was not checked against a primary source here).

### 3.2 Pusher (pusher-js + pusher-http-node)

- Client: `pusher.subscribe(channelName: string)`; `Channel.bind(eventName: string, callback: Function, context?)` ([`dispatcher.ts`](https://github.com/pusher/pusher-js/blob/master/src/core/events/dispatcher.ts)). Server: `trigger(channel, event, data)` and `authorizeChannel(socketId, channel, data?: PresenceChannelData): ChannelAuthResponse` ([`index.d.ts`](https://github.com/pusher/pusher-http-node/blob/master/index.d.ts)). **Untyped names, `Function` callbacks, untyped payloads.**
- Authorize is decided by **name prefix**: [`channels.ts`](https://github.com/pusher/pusher-js/blob/master/src/core/channels/channels.ts) `createChannel` dispatches on `private-encrypted-`, `private-`, `presence-` prefixes (and rejects names starting with `#`). `PrivateChannel.authorize` calls `config.channelAuthorizer({ channelName, socketId }, callback)` ([`private_channel.ts`](https://github.com/pusher/pusher-js/blob/master/src/core/channels/private_channel.ts)), configured via `channelAuthorization: { endpoint, headers, params } | { customHandler }` ([`auth/options.ts`](https://github.com/pusher/pusher-js/blob/master/src/core/auth/options.ts)). The endpoint receives `socket_id` + `channel_name`, does app-specific checks, and returns the HMAC signature from `pusher.authorizeChannel(...)` ([`pusher.js`](https://github.com/pusher/pusher-http-node/blob/master/lib/pusher.js)).
- Naming rules from the [channels docs](https://pusher.com/docs/channels/using_channels/channels/): max 164 chars including prefix; letters, numbers and `_ - = @ , . ;`; "Private channels, private encrypted channels, and presence channels all require server authorization to access, whereas public channels do not."

Takeaway: authorization happens **per channel on subscribe**, via a developer-written endpoint that receives only the concrete channel name — the developer has to parse params out of the name themselves. That is exactly the gap a typed registry closes.

### 3.3 tRPC subscriptions (SSE)

- A subscription is a **named procedure** with `.input(schema)` and an async-generator handler; `lastEventId` flows from the `EventSource` `Last-Event-ID` header into `.input()` when events are yielded with `tracked(id, data)` ([subscriptions.md](https://github.com/trpc/trpc/blob/main/www/docs/server/subscriptions.md)). Output typing is via `.output(zAsyncIterable({ yield: schema, tracked: true }))`. Client: `trpc.onPostAdd.subscribe({ lastEventId: null }, { onData(post) {...} })` with the whole router typed through `import type { AppRouter }` ([subscriptions SKILL.md](https://github.com/trpc/trpc/blob/main/packages/server/skills/subscriptions/SKILL.md)).
- There is no "channel" concept: parameters are the validated `input`; the procedure name is the registry key (object path, e.g. `post.onAdd`), not a string pattern.
- Authorize is **middleware on the procedure** (`protectedProcedure = t.procedure.use(isAuthed)`), with the context narrowed (`ctx.user` non-null) ([authorization.md](https://github.com/trpc/trpc/blob/main/www/docs/server/authorization.md)). For per-entity checks you read `input` inside the handler.
- Transport-level auth with native `EventSource`: same-domain cookies work by default; cross-domain needs `withCredentials: true`; custom headers need an `EventSource` ponyfill; `connectionParams` go in the URL "which is why other methods are preferred"; and because `EventSource` cannot re-run `eventSourceOptions()` on reconnect, refreshing expired auth needs `retryLink` to recreate the connection — which "means any previously tracked events will be lost" ([httpSubscriptionLink.md](https://github.com/trpc/trpc/blob/main/www/docs/client/links/httpSubscriptionLink.md)).

Takeaway: tRPC shows (a) input validator = params type, (b) one declaration typed on both ends via a type-only import, and (c) the native-`EventSource` auth constraints next-sse inherits (cookie auth, re-check on every reconnect — consistent with the map's "Authorize runs per Channel on every connect").

### 3.4 Socket.IO typed events

- Typing is four interfaces on the generic: `new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>()`, e.g. `basicEmit: (a: number, b: string, c: Buffer) => void`; then `socket.emit("basicEmit", 1, "2", Buffer.from([3]))` and `io.to("room1").emit("basicEmit", ...)` are checked ([typescript.md](https://github.com/socketio/socket.io-website/blob/main/docs/categories/01-Documentation/typescript.md)). The client mirrors them: `Socket<ServerToClientEvents, ClientToServerEvents>`.
- Rooms — the closest analogue to a Channel — are **untyped**: `export type Room = string;` ([`in-memory-adapter.ts`](https://github.com/socketio/socket.io/blob/main/packages/socket.io-adapter/lib/in-memory-adapter.ts)). Events are typed, rooms are not, so there is no "payload per room" typing.
- The docs warn: "These type hints do not replace proper validation/sanitization of the input."
- Authorize: connection-level `io.use((socket, next) => { if (isValid(socket.request)) next(); else next(new Error("invalid")); })` ([middlewares.md](https://github.com/socketio/socket.io-website/blob/main/docs/categories/02-Server/middlewares.md)); room membership is decided server-side by calling `socket.join(room)`.

Takeaway: the "events interface shared by `import type`" pattern is simple and widely understood, but it types the *event*, not the *addressed entity*; a Channel registry needs both.

### 3.5 Hono (typed RPC, SSE helper, path params, Standard Schema validator)

- RPC: `export type AppType = typeof route` on the server; `import type { AppType }` + `hc<AppType>(url)` on the client ([rpc.md](https://github.com/honojs/website/blob/main/docs/guides/rpc.md)). Path and query values "**must** be passed as `string`". The docs devote a section to **IDE performance**: "the more routes you have, the slower your IDE will become" because of type instantiation; the recommended mitigation is to pre-compile the client type (`export type Client = ReturnType<typeof hc<typeof app>>`) with `tsc`.
- SSE: `streamSSE(c, async (stream) => { await stream.writeSSE({ data, event, id }) })` where `SSEMessage.data: string | Promise<string>` ([`helper/streaming/sse.ts`](https://github.com/honojs/hono/blob/main/src/helper/streaming/sse.ts)). **The SSE payload is an untyped string; Hono RPC does not type SSE event payloads.**
- Path params are inferred with template-literal types ([`types.ts`](https://github.com/honojs/hono/blob/main/src/types.ts)):

  ```ts
  type ParamKey<Component> = Component extends `:${infer NameWithPattern}`
    ? NameWithPattern extends `${infer Name}{${infer Rest}`
      ? Rest extends `${infer _Pattern}?` ? `${Name}?` : Name
      : NameWithPattern
    : never
  export type ParamKeys<Path> = Path extends `${infer Component}/${infer Rest}`
    ? ParamKey<Component> | ParamKeys<Rest>
    : ParamKey<Path>
  export type ParamKeyToRecord<T extends string> = T extends `${infer R}?`
    ? Record<R, string | undefined>
    : { [K in T]: string }
  ```

  Hono's `:name{regex}?` syntax is a direct precedent for encoding a per-param constraint and optionality in the name pattern.
- Standard Schema: `@hono/standard-validator`'s `sValidator(target, schema, hook?)` accepts any `StandardSchemaV1`, and the failure branch exposes `readonly StandardSchemaV1.Issue[]` ([`standard-validator/src/index.ts`](https://github.com/honojs/middleware/blob/main/packages/standard-validator/src/index.ts)).
- Authorize: ordinary middleware on the route; nothing channel-specific.

### 3.6 Zero (Rocicorp) — briefly

- Synced queries are **named, validated, shared definitions**: `defineQueries({ postsByAuthor: defineQuery(z.object({ authorID: z.string() }), ({ args: { authorID } }) => zql.post.where('authorID', authorID)) })`; `queryName` is computed from the registry path (`"posts.all"`) and sent to the server to identify the query ([queries.mdx](https://github.com/rocicorp/zero-docs/blob/main/contents/docs/queries.mdx)).
- "Zero queries run on both the client and on your server. In the server case, the parameters come from the client and are untrusted. The validator ensures the data passed to your query is of the expected type." — the validator is *required* for args; any Standard Schema works.
- Authorize: a **`ctx`** argument the client cannot control ("Query parameters are supplied by the client application ... This makes them unsuitable for credentials ... Zero queries also support the concept of a context object"), and a server endpoint (`handleQueryRequest` → `mustGetQuery(queries, name)` → `query.fn({ args, ctx: session?.user })`). The server copy may add filters the client copy does not ([auth.mdx](https://github.com/rocicorp/zero-docs/blob/main/contents/docs/auth.mdx)). Denial is expressed by returning an always-false query rather than throwing.

Takeaway: "registry object → name derived from key; validated args; server-only ctx for authorization; same file imported on both sides" is essentially the shape next-sse needs, minus the SSE specifics.

### 3.7 Electric — briefly

- Typing is a caller-supplied generic, `ShapeStream<T extends Row<unknown> = Row>` / `useShape<T extends Row<unknown>>` ([`client.ts`](https://github.com/electric-sql/electric/blob/main/packages/typescript-client/src/client.ts), [`react-hooks.tsx`](https://github.com/electric-sql/electric/blob/main/packages/react-hooks/src/react-hooks.tsx)); no registry, no name typing.
- Authorize: "it's all just HTTP" — shapes are resources requested via `GET /v1/shape?table=...`, authorized by a **proxy** in front of Electric (which sets shape params server-side) or by a **gatekeeper** endpoint that mints a token whose claim contains the exact shape definition, verified by the proxy ("running once when generating a token, rather than on the hot path of every shape request") ([auth.md](https://github.com/electric-sql/electric/blob/main/website/docs/sync/guides/auth.md)).

Takeaway: both Electric patterns put Authorize at a request boundary keyed on the *parameters of the subscription*; the gatekeeper one is the same "capability token" idea as Ably and Inngest.

### 3.8 Inngest Realtime v4 — the closest match

Docs: [Realtime](https://www.inngest.com/docs/features/realtime). Source: [`components/realtime/channel.ts`](https://github.com/inngest/inngest-js/blob/main/packages/inngest/src/components/realtime/channel.ts).

```ts
// inngest/channels.ts — "Channels are defined once and shared between your function code and your client code."
export const pipelineChannel = realtime.channel({
  name: ({ contentId }: { contentId: string }) => `pipeline:${contentId}`,
  topics: {
    status: { schema: z.object({ message: z.string(), progress: z.number() }) }, // validated at publish time
    tokens: { schema: staticSchema<{ token: string }>() },                          // types only
  },
});

// server
await inngest.realtime.publish(pipelineChannel({ contentId }).status, { message: "Starting...", progress: 0 });

// server action: "Authorize before minting: the token is a capability"
return getClientSubscriptionToken(inngest, { channel: pipelineChannel({ contentId }), topics: ["status", "result"] });

// client
const { messages } = useRealtime({ channel: pipelineChannel({ contentId }), topics: ["status", "result"] as const, token: () => fetchToken(contentId) });
```

Implementation notes from `channel.ts`: `name` is `string | ((...args) => string)`; when it is a function the definition is itself callable and returns an instance `{ name, topics, ...topicAccessors }` where each accessor is `{ channel, topic, config }`; `$infer` / `$params` phantom properties carry the types. The `const` generic on `TName` makes the returned name a literal template. Publish-time validation checks `result.issues` (§2.3). Authorize happens **once, server-side, at token mint**, not inside the channel definition.

### 3.9 Summary table

| Library | Channel name typing | Params | Payload typing | Validation | Where Authorize lives |
|---|---|---|---|---|---|
| Ably | `string` | by convention (`ns:id`) | `data: any` | none | token capabilities (server mints), wildcard per `:` segment |
| Pusher | `string` with `private-`/`presence-` prefix | none (parse name yourself) | `Function` callback | none | `channelAuthorization` endpoint per subscribe, receives `channel_name` + `socket_id` |
| tRPC subs | procedure path (object key) | `.input(schema)` | `.output(zAsyncIterable)` / inferred | Standard Schema or native | procedure middleware + handler logic (`ctx`) |
| Socket.IO | `Room = string` | none | typed events via 4 generic interfaces | none ("do not replace validation") | `io.use` middleware; `socket.join` server-side |
| Hono | route path (template-literal `ParamKeys`) | `:name{regex}?` | RPC: yes; SSE: `data: string` | `@hono/standard-validator` | route middleware |
| Zero | registry key (`posts.all`) | required validator (Standard Schema) | inferred from ZQL | Standard Schema | server query endpoint with `ctx` |
| Electric | none | shape params in URL | `ShapeStream<T>` (asserted) | none | HTTP proxy or gatekeeper token |
| Inngest Realtime | literal template from `name` fn | fn argument type | Standard Schema per topic, `staticSchema<T>()` | Standard Schema on publish (+ optional on subscribe) | server action that mints a channel+topics token |

## 4. TypeScript patterns for `chat:{roomId}` with inferred params

All snippets below were checked with `tsc --strict --noEmit` on TypeScript 5.9.3 and 7.0.2; the `@ts-expect-error` lines are part of the assertions.

### 4.1 Extract param names and build the params object

```ts
type ParamNames<P extends string> =
  P extends `${infer _Head}{${infer Name}}${infer Rest}` ? Name | ParamNames<Rest> : never;
type Params<P extends string> = { [K in ParamNames<P>]: string };

type A2 = ParamNames<'org:{orgId}:doc:{docId}'>;   // "orgId" | "docId"
type A3 = ParamNames<'broadcast'>;                 // never
const a4: Params<'org:{orgId}:doc:{docId}'> = { orgId: 'o', docId: 'd' };
// @ts-expect-error missing docId
const a4bad: Params<'org:{orgId}:doc:{docId}'> = { orgId: 'o' };
```

### 4.2 Pattern → concrete-name type, and filling it at runtime

```ts
type Interpolate<P extends string> =
  P extends `${infer Head}{${infer _Name}}${infer Rest}` ? `${Head}${string}${Interpolate<Rest>}` : P;

type N1 = Interpolate<'chat:{roomId}'>;   // `chat:${string}`
const n1: N1 = 'chat:123';
// @ts-expect-error wrong prefix
const n1bad: N1 = 'chatx:123';

function fill<P extends string>(pattern: P, params: Params<P>): Interpolate<P> {
  return pattern.replace(/\{(\w+)\}/g, (_, k: string) => (params as Record<string, string>)[k]) as Interpolate<P>;
}
const name = fill('chat:{roomId}', { roomId: '42' }); // `chat:${string}`
// @ts-expect-error unknown param
fill('chat:{roomId}', { room: '42' });
```

### 4.3 Parse a concrete name back into params (type level)

```ts
// literal text that follows a placeholder, up to the next placeholder (or the end)
type NextLiteral<Rest extends string> = Rest extends `${infer L}{${string}` ? L : Rest;

type ParseName<P extends string, S extends string> =
  P extends `${infer Head}{${infer Name}}${infer Rest}`
    ? Rest extends ''
      ? (S extends `${Head}${infer Value}` ? { [K in Name]: Value } : never)
      : (S extends `${Head}${infer Value}${NextLiteral<Rest>}${infer Tail}`
          ? { [K in Name]: Value } & ParseName<Rest, `${NextLiteral<Rest>}${Tail}`>
          : never)
    : S extends P ? {} : never;

const p1: ParseName<'chat:{roomId}', 'chat:42'> = { roomId: '42' };
const p2: ParseName<'org:{orgId}:doc:{docId}', 'org:acme:doc:7'> = { orgId: 'acme', docId: '7' };
```

### 4.4 Registry keyed by pattern; look a concrete name up

```ts
type Registry = {
  'chat:{roomId}': { text: string };
  'user:{userId}:notifications': { id: number };
  'broadcast': { msg: string };
};
type MatchPattern<R, S extends string> =
  { [K in keyof R & string]: S extends Interpolate<K> ? K : never }[keyof R & string];

type M1 = MatchPattern<Registry, 'chat:42'>;               // "chat:{roomId}"
type M2 = MatchPattern<Registry, 'user:7:notifications'>;  // "user:{userId}:notifications"
type M3 = MatchPattern<Registry, 'nope'>;                  // never

// template-literal index signatures (TS 4.4+) work for "bag" objects too
const byName: Record<`chat:${string}`, number> = {};
byName['chat:1'] = 1;
// @ts-expect-error not matching the pattern
byName['room:1'] = 1;
```

### 4.5 Compiler limits (measured)

1. **Only literals narrow.** `useChannel('chat:42')` infers `S = 'chat:42'` and resolves to `'chat:{roomId}'`; but with `declare const dyn: string`, `useChannel(dyn)` collapses to `never` because `string extends \`chat:${string}\`` is false. Any API that types by *matching the concrete name* therefore only works when the caller passes a literal or a template literal built from literals — which is rare for a `roomId` that comes from props or the URL. (This is the decisive argument for candidate B in §6.)
2. **`infer` in template literals is non-greedy**: `'a:b:c' extends \`${infer X}:${infer Y}\`` gives `X = 'a'`, `Y = 'b:c'`. Consequences: adjacent placeholders `{a}{b}` are ambiguous (`{a}` gets one character); a value that itself contains the following literal is split at the first occurrence — exactly like the runtime regex `/^chat:(.*?):user:(.*)$/` would. A literal separator between placeholders is required (Ably's `:`-segment rule is the same constraint at the service level).
3. **Union size.** `\`${Two}${Two}\`` (10 000 members) compiles; `\`${Two}${Two}${Digits}\`` (100 000 members) fails with `TS2590: Expression produces a union type that is too complex to represent` on both 5.9.3 and 7.0.2. Patterns must use `${string}`, never enumerate values.
4. **Instantiation cost.** Hono's RPC docs document IDE slow-down with many routes and recommend pre-compiling types; a registry with tens of channels is far below that, but the mapped-type lookup (`MatchPattern`) is evaluated per call site and should stay shallow.

## 5. Sharing the registry between server and client without leaking server code

- **`import type` is erased.** "`import type` only imports declarations to be used for type annotations and declarations. It *always* gets fully erased, so there's no remnant of it at runtime." ([TypeScript 3.8 release notes](https://github.com/microsoft/TypeScript-Website/blob/v2/packages/documentation/copy/en/release-notes/TypeScript%203.8.md)). This is what tRPC (`import type { AppRouter }`) and Hono (`import type { AppType }`) rely on: the client bundle never contains the server module. It only works when the *value* is not needed on the client — fine for tRPC, where the client is a proxy keyed by string paths.
- **`server-only` is a build-time poison pill.** Next.js: "Next.js handles `server-only` and `client-only` imports internally to provide clearer error messages when a module is used in the wrong environment. The contents of these packages from NPM are not used by Next.js." and "installing `server-only` or `client-only` is optional" ([server-and-client-components.mdx](https://github.com/vercel/next.js/blob/canary/docs/01-app/01-getting-started/05-server-and-client-components.mdx)). The npm package itself is `throw new Error("This module cannot be imported from a Client Component module...")` with a `react-server` export condition mapping to an empty file ([`packages/next/src/compiled/server-only`](https://github.com/vercel/next.js/tree/canary/packages/next/src/compiled/server-only)).
- **Zero and Inngest share the *value*.** Both put the definitions in one file imported by both sides (Zero: "A copy of each query exists on both the client and on your server ... Often the implementations will be the same, and you can just share their code"; Inngest: "Channels are defined once and shared between your function code and your client code"). What makes this safe is that the shared file contains only *names, validators and pure functions*; credentials come from a server-only `ctx` (Zero) or a server-only token-minting action (Inngest). Zero explicitly notes the server copy "can add extra filters to enforce permissions that the client query does not".

Implication: the client needs the **schema values** (if it re-validates or uses transforms) and the **name function**, but must not see `authorize` (which imports DB/session code). Two viable layouts:

- **Split files**: `channels.ts` (shared: names + schemas) and `channels.server.ts` (`import 'server-only'`; attaches `authorize` per channel and builds the `createSSE()` instance). The client imports only `channels.ts`.
- **Type-only client**: client imports `import type { Channels }` and addresses channels by name; no schema values on the client, so no client-side validation and no bundle cost. Inngest's older `typeOnlyChannel` helper ([`packages/realtime/src/channel.ts`](https://github.com/inngest/inngest-js/blob/main/packages/realtime/src/channel.ts)) is this pattern via `Proxy`.

Note that schema libraries themselves are client-safe (zod/valibot/arktype run in browsers), so sharing schema values is a bundle-size question, not a safety one; `authorize` is the only thing that must stay server-side.

## 6. Candidate API shapes

All three were type-checked as skeletons (§4 file plus a candidates file, TS 5.9.3) with a fake Standard Schema library to confirm `publish`, `authorize` and the hook infer from one declaration.

### Candidate A — pattern-keyed registry (`createChannels`)

```ts
// channels.ts (shared)
export const channels = createChannels({
  'chat:{roomId}': { schema: z.object({ text: z.string() }) },
  'user:{userId}:notifications': { schema: z.object({ id: z.string() }) },
  broadcast: { schema: z.object({ msg: z.string() }) },
});
// channels.server.ts
import 'server-only';
export const sse = createSSE({ channels, authorize: {
  'chat:{roomId}': ({ roomId }, ctx) => isMember(ctx.userId, roomId), // params inferred from the key
  'user:{userId}:notifications': ({ userId }, ctx) => ctx.userId === userId,
} });
// usage
sse.publish('chat:42', { text: 'hi' });            // OK when the name is a literal
useChannel('user:7:notifications', (m) => m.id);   // OK when the name is a literal
sse.publish(dynamicName, { text: 'hi' });          // ERROR: collapses to never (§4.5.1)
```

- Pros: one visible vocabulary (`chat:{roomId}` reads like Ably/Pusher names and like the Prefix/wire format docs); `authorize` params inferred from the key (verified: a `{ [K in keyof R & string]: Def<K> }` constraint gives contextual typing); the registry is a plain object, serialisable for docs/skills.
- Cons: **the name-matching trick only types literal names**; real apps build names from variables, so every call site degrades to `never`/`any` or needs a helper like `channels.chat({ roomId })` — at which point it *is* candidate B with extra parsing. Type-level parsing is an extra, fragile layer (non-greedy `infer`, delimiter rules) duplicated by the runtime parser. Nothing in the survey does this.

### Candidate B — `defineChannel` with a name function (Inngest/Zero-style)

```ts
// channels.ts (shared)
export const chat = defineChannel({
  name: ({ roomId }: { roomId: string }) => `chat:${roomId}` as const,
  schema: z.object({ text: z.string() }),
});
export const notifications = defineChannel({
  name: ({ userId }: { userId: string }) => `user:${userId}:notifications` as const,
  schema: z.object({ id: z.string() }),
});
export const broadcast = defineChannel({ name: 'broadcast', schema: z.object({ msg: z.string() }) });

// server
sse.publish(chat({ roomId }), { text: 'hi' });     // payload typed via InferInput<schema>; roomId may be dynamic
// client
useChannel(chat({ roomId }), (m) => m.text);         // m: InferOutput<schema>
```

- Pros: params are **values**, so typing is ordinary function typing — no template-literal parsing, no literal-only limitation; a Channel instance `{ name, $schema }` is a single typed handle passed to `publish`, `authorize`, the hook and the server-component initial-data path; the name function is also the documented wire name (Prefix + name); `staticSchema<T>()`-style types-only escape hatch is trivial. This is the pattern two production libraries (Inngest v4, Zero) converged on.
- Cons: the name is computed, so "which pattern does this concrete name belong to?" on the **server receive side** (a Connection asks for `chat:42`) still needs a runtime parser/matcher; the name function must be invertible (a declared pattern string or a `parse` companion). Without it, `authorize` cannot get typed params from an incoming name. Also, `as const` on the returned template is easy to forget — the helper should add it (Inngest uses `const TName` generics).

### Candidate C — B plus a server-only `authorize` attachment (split registry)

```ts
// channels.ts (shared, no server imports)
export const chat = defineChannel({
  pattern: 'chat:{roomId}',                       // declarative, parseable both ways
  schema: z.object({ text: z.string() }),
});
// channels.server.ts
import 'server-only';
export const sse = createSSE({
  channels: [chat, notifications, broadcast],
  authorize: {
    chat: async ({ roomId }, ctx) => isMember(ctx.userId, roomId),   // params: { roomId: string } from the pattern
    notifications: ({ userId }, ctx) => ctx.userId === userId,
  },
});
export const { GET } = sse.handlers;
// usage: identical to B — chat({ roomId }) builds a typed instance; the server parses incoming names with the same pattern
```

- Pros: keeps B's value-level params for callers, and adds a **declarative pattern** so the server can parse `chat:42` → `{ roomId: '42' }` with one regex derived from the pattern (the same parse at type level is §4.3, used only for tests/docs). `authorize` is physically server-only, and absent from the client bundle. The registry (`channels: [...]`) gives `createSSE` the complete set for the Connection's "any denied Channel refuses the whole Connection" rule and for docs generation.
- Cons: two files and a registration step (forgetting to register a channel must be a runtime error at `createSSE`); `authorize` keyed by channel *key* means `defineChannel` needs a stable key (the variable name is not available at runtime — use an explicit `key` or an object registry `createChannels({ chat: defineChannel(...) })` like Zero's `defineQueries`).

### Recommendation

Adopt **candidate C**: `defineChannel({ pattern, schema })` in a shared module, registered into `createSSE({ channels, authorize })` in a `server-only` module, with Channel *instances* (`chat({ roomId })`) as the typed handle for `publish`, `useChannel` and initial-data helpers. Keep candidate A's `chat:{roomId}` strings as the **pattern syntax** (documented, Ably-style `:` segments, one literal separator between placeholders) rather than as the registry key, and keep the template-literal types of §4 as internal helpers for `Params<pattern>` inference in `authorize` — that is the one place where the pattern string is the source of truth and the literal-only limitation does not bite (patterns are always literals).

Why not pure B: the server must parse incoming names on connect; a declared pattern makes that a library concern instead of a per-channel `parse` the developer writes. Why not A: literal-only matching is a trap for the most common call (`publish` with a dynamic id), and no surveyed library does it.

## 7. Open questions

1. **Input vs Output on the wire.** `publish` accepts `InferInput`, validates, and sends `result.value` (`InferOutput`). Should the client hook receive `InferOutput` *without* re-validating (trusting the server; zero client bundle cost) or re-validate like Inngest's opt-in `validate`? The latter requires schema values in the client bundle and a Promise-tolerant path.
2. **JSON-serialisability.** Standard Schema does not constrain `Output`; zod can output `Date`, `Map`, `bigint`. Either constrain with a `JsonValue` type bound on the schema output (compile error on `Date`), or document that the wire is `JSON.stringify` and the client sees the JSON form. This also touches the "processes outside Next.js publish via Redis" contract.
3. **Pattern grammar.** `{name}` vs Hono's `:name{regex}?`; whether to support a regex/constraint per param, optional params, and a trailing wildcard (Ably `foo:*`). Minimal v0.1 proposal: `{name}` only, literal separators required, no optionals.
4. **Registration key.** Explicit `key` in `defineChannel`, or an object registry (`createChannels({ chat: defineChannel(...) })`) that derives keys like Zero's `queryName`? The object form also makes `authorize: { chat: ... }` exhaustively typed (`Record<keyof Channels, AuthorizeFn>`), so a forgotten `authorize` is a compile error rather than a default-deny at runtime.
5. **Authorize signature.** `(params, ctx) => boolean` vs returning a narrowed value or throwing; what is `ctx` (the `Request` plus a user-provided `createContext` as in tRPC/Zero?); sync vs async; and how the "any denied Channel refuses the whole Connection" rule reports *which* Channel failed without leaking to the client.
6. **Per-channel vs registry-level schemas for a Channel with several Message kinds.** Inngest uses Channel → Topics; the map says "Channel is the only primitive". A discriminated-union schema per Channel covers most cases; worth confirming with a grilling ticket before freezing.
7. **Types-only channels.** Ship a `staticSchema<T>()` equivalent for users who do not want any validator, given the spec allows a passthrough `validate`.
8. **Spec version drift.** `@standard-schema/spec` is at 1.1.0 but its CHANGELOG stops at 1.0.0; if next-sse vendors the types, pin to the `StandardSchemaV1` subset and record the commit.

## Sources

- Standard Schema: [spec source `index.ts`](https://github.com/standard-schema/standard-schema/blob/main/packages/spec/src/index.ts), [`schema.md` (interface, implementers, FAQ)](https://github.com/standard-schema/standard-schema/blob/main/packages/spec/schema.md), [`package.json` 1.1.0](https://github.com/standard-schema/standard-schema/blob/main/packages/spec/package.json), [`CHANGELOG.md`](https://github.com/standard-schema/standard-schema/blob/main/packages/spec/CHANGELOG.md), [standardschema.dev](https://standardschema.dev/)
- zod: [`v4/core/schemas.ts`](https://github.com/colinhacks/zod/blob/main/packages/zod/src/v4/core/schemas.ts), [`package.json`](https://github.com/colinhacks/zod/blob/main/packages/zod/package.json)
- valibot: [`_getStandardProps.ts`](https://github.com/fabian-hiller/valibot/blob/main/library/src/utils/_getStandardProps/_getStandardProps.ts)
- arktype: [`ark/schema/roots/root.ts`](https://github.com/arktypeio/arktype/blob/main/ark/schema/roots/root.ts)
- Ably: [`ably.d.ts`](https://github.com/ably/ably-js/blob/main/ably.d.ts), [Capabilities docs](https://ably.com/docs/auth/capabilities)
- Pusher: [`pusher-js` channels.ts](https://github.com/pusher/pusher-js/blob/master/src/core/channels/channels.ts), [private_channel.ts](https://github.com/pusher/pusher-js/blob/master/src/core/channels/private_channel.ts), [auth/options.ts](https://github.com/pusher/pusher-js/blob/master/src/core/auth/options.ts), [events/dispatcher.ts](https://github.com/pusher/pusher-js/blob/master/src/core/events/dispatcher.ts), [`pusher-http-node` lib/pusher.js](https://github.com/pusher/pusher-http-node/blob/master/lib/pusher.js), [index.d.ts](https://github.com/pusher/pusher-http-node/blob/master/index.d.ts), [Channels docs](https://pusher.com/docs/channels/using_channels/channels/)
- tRPC: [subscriptions.md](https://github.com/trpc/trpc/blob/main/www/docs/server/subscriptions.md), [httpSubscriptionLink.md](https://github.com/trpc/trpc/blob/main/www/docs/client/links/httpSubscriptionLink.md), [authorization.md](https://github.com/trpc/trpc/blob/main/www/docs/server/authorization.md), [validators.md](https://github.com/trpc/trpc/blob/main/www/docs/server/validators.md), [parser.ts](https://github.com/trpc/trpc/blob/main/packages/server/src/unstable-core-do-not-import/parser.ts), [subscriptions SKILL.md](https://github.com/trpc/trpc/blob/main/packages/server/skills/subscriptions/SKILL.md)
- Socket.IO: [typescript.md](https://github.com/socketio/socket.io-website/blob/main/docs/categories/01-Documentation/typescript.md), [middlewares.md](https://github.com/socketio/socket.io-website/blob/main/docs/categories/02-Server/middlewares.md), [`in-memory-adapter.ts` (`Room = string`)](https://github.com/socketio/socket.io/blob/main/packages/socket.io-adapter/lib/in-memory-adapter.ts)
- Hono: [rpc.md](https://github.com/honojs/website/blob/main/docs/guides/rpc.md), [streaming.md](https://github.com/honojs/website/blob/main/docs/helpers/streaming.md), [`helper/streaming/sse.ts`](https://github.com/honojs/hono/blob/main/src/helper/streaming/sse.ts), [`types.ts` (ParamKeys)](https://github.com/honojs/hono/blob/main/src/types.ts), [`@hono/standard-validator`](https://github.com/honojs/middleware/blob/main/packages/standard-validator/src/index.ts)
- Zero: [queries.mdx](https://github.com/rocicorp/zero-docs/blob/main/contents/docs/queries.mdx), [auth.mdx](https://github.com/rocicorp/zero-docs/blob/main/contents/docs/auth.mdx)
- Electric: [auth.md](https://github.com/electric-sql/electric/blob/main/website/docs/sync/guides/auth.md), [`typescript-client/src/client.ts`](https://github.com/electric-sql/electric/blob/main/packages/typescript-client/src/client.ts), [`react-hooks.tsx`](https://github.com/electric-sql/electric/blob/main/packages/react-hooks/src/react-hooks.tsx)
- Inngest: [Realtime docs](https://www.inngest.com/docs/features/realtime), [`components/realtime/channel.ts`](https://github.com/inngest/inngest-js/blob/main/packages/inngest/src/components/realtime/channel.ts), [`components/Inngest.ts` (publish validation)](https://github.com/inngest/inngest-js/blob/main/packages/inngest/src/components/Inngest.ts), [`TokenSubscription.ts`](https://github.com/inngest/inngest-js/blob/main/packages/inngest/src/components/realtime/subscribe/TokenSubscription.ts), [`triggers.ts` (`staticSchema`)](https://github.com/inngest/inngest-js/blob/main/packages/inngest/src/components/triggers/triggers.ts), legacy [`packages/realtime/src/channel.ts`](https://github.com/inngest/inngest-js/blob/main/packages/realtime/src/channel.ts)
- Next.js / TypeScript: [server-and-client-components.mdx](https://github.com/vercel/next.js/blob/canary/docs/01-app/01-getting-started/05-server-and-client-components.mdx), [`compiled/server-only`](https://github.com/vercel/next.js/tree/canary/packages/next/src/compiled/server-only), [TypeScript 3.8 release notes (type-only imports)](https://github.com/microsoft/TypeScript-Website/blob/v2/packages/documentation/copy/en/release-notes/TypeScript%203.8.md)
