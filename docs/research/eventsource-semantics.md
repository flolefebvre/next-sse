# EventSource semantics and client-side reconnection

Research for [issue #5](https://github.com/flolefebvre/next-sse/issues/5), part of the v0.1 map ([#1](https://github.com/flolefebvre/next-sse/issues/1)). Date: 2026-08-23.

**Question.** What exactly does the browser `EventSource` do, and where does it fall short for gap-free delivery? What can the client core rely on natively, and what must it implement itself?

Terms follow `CONTEXT.md`: a *Connection* is one client's single SSE stream multiplexing all its *Channels*; *Publish* puts a *Message* on a Channel; *Authorize* runs per Channel on every connect.

## Summary

- Native `EventSource` gives you exactly one thing for free that is hard to get otherwise: a cross-origin request that carries cookies (`withCredentials`) and the `Last-Event-ID` header **without a CORS preflight**. Everything else relevant to gap-free delivery is either not provided or actively hostile.
- The browser reconnects automatically only after a *200 `text/event-stream`* response ends (clean close or mid-stream drop). **Any non-200 response, including 5xx, is fatal**: `readyState` goes to `CLOSED` and the object never retries. All three engines and Node agree with the current spec on this; the old W3C text that retried on 500/502/503/504 is gone.
- The reconnect delay is fixed (3 s Chromium/WebKit/Node, 5 s Firefox), server-settable via `retry:`, with **no backoff in any engine**. The `error` event carries no information; the only observable distinction between "will retry" and "gave up" is `readyState` (`CONNECTING` vs `CLOSED`). Server-initiated close and network drop are indistinguishable.
- `Last-Event-ID` is per-`EventSource`-object state. It is sent **only on the browser's own reconnects**, never on the first request, and a freshly constructed object starts empty. Any reconnect the client core performs itself (after a fatal error, after a 401, to change the Channel set) therefore has to carry the cursor some other way (URL query), and the server must accept both. Interop trap: only Chromium applies the `id` of a data-less block; Firefox drops it and WebKit defers it, so ids belong on real events only.
- Lifecycle: Chromium lets a page with an open stream enter bfcache but evicts it after 60 s or 1 MB of buffered bytes; WebKit cancels the stream on entry and reconnects on restore; Firefox blocks bfcache while the stream is open (read from source, not verified). Background-tab timer throttling in Chrome does not touch the native reconnect timer, but it does throttle any `setTimeout`-based reconnect a fetch-based client would use.
- Per-host limits: 6 connections per host on HTTP/1.1 in Chromium and Firefox (both "WontFix"); on HTTP/2 the limit is the server's `SETTINGS_MAX_CONCURRENT_STREAMS` (RFC recommends >= 100; Firefox's client-side default is 100).
- Fetch-based libraries buy custom headers, response-status visibility and full reconnect control, at the cost of preflights for cross-origin `Last-Event-ID`, and, for `@microsoft/fetch-event-source`, no Node support and no reconnect on clean close. `eventsource` (npm, v5) is a faithful spec polyfill with a `fetch` hook; `eventsource-parser` is the parser both should share.
- **Recommendation:** keep native `EventSource` as the v0.1 transport (as settled in the map), but treat it as a dumb pipe: the client core owns the cursor, the retry policy, fatal-error recovery and visibility handling, and the wire protocol must be designed so that a cursor can travel in the URL as well as in `Last-Event-ID`. See [section 7](#7-what-the-client-core-can-rely-on-natively-vs-what-it-must-implement-itself).

## Sources

| Tag | Source |
| --- | --- |
| [SPEC] | WHATWG HTML Living Standard, §9.2 Server-sent events, <https://html.spec.whatwg.org/multipage/server-sent-events.html> (fetched 2026-08-23) |
| [SPEC-W3C-2015] | W3C Recommendation "Server-Sent Events", 3 Feb 2015 (historical), <https://www.w3.org/TR/2015/REC-eventsource-20150203/> |
| [FETCH] | WHATWG Fetch Standard, <https://fetch.spec.whatwg.org/> (fetched 2026-08-23) |
| [MDN-ES] | MDN, `EventSource`, <https://developer.mozilla.org/en-US/docs/Web/API/EventSource> |
| [MDN-USING] | MDN, "Using server-sent events", <https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events> |
| [CR-ES] | Chromium `third_party/blink/renderer/modules/eventsource/event_source.cc` (main), <https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/eventsource/event_source.cc> |
| [CR-PARSER] | Chromium `.../eventsource/event_source_parser.cc` (main) |
| [CR-SOCKET] | Chromium `net/socket/client_socket_pool_manager.cc` (main) |
| [CR-BFC] | Chromium `content/browser/back_forward_cache/back_forward_cache_impl.cc`, `third_party/blink/renderer/platform/loader/fetch/resource_loader.cc`, `.../url_loader/mojo_url_loader_client.cc`, `.../platform/back_forward_cache_buffer_limit_tracker.cc`, `third_party/blink/common/features.cc` (main) |
| [CR-SCHED] | Chromium `third_party/blink/renderer/platform/scheduler/main_thread/frame_scheduler_impl.cc` (main) |
| [CR-THROTTLE] | "Timer throttling in Chrome 88", <https://developer.chrome.com/blog/timer-throttling-in-chrome-88> |
| [CR-LIFECYCLE] | "Page Lifecycle API", <https://developer.chrome.com/docs/web-platform/page-lifecycle-api> |
| [WEBDEV-BFC] | web.dev, "Back/forward cache", <https://web.dev/articles/bfcache> |
| [FF-ES] | Firefox `dom/base/EventSource.cpp` (main), <https://github.com/mozilla-firefox/firefox/blob/main/dom/base/EventSource.cpp> |
| [FF-DOC] | Firefox `dom/base/Document.cpp` (main), bfcache eligibility (`BFCacheStatus::REQUEST`) |
| [FF-PREFS] | Firefox `modules/libpref/init/StaticPrefList.yaml` and `all.js` (main) |
| [FF-BUG-906896] | Bugzilla 906896 "Increase number of permitted EventSource connections", RESOLVED WONTFIX (2014-02-20) |
| [FF-BUG-831392] | Bugzilla 831392 "Server sent events, no reconnection", RESOLVED FIXED |
| [WK-ES] | WebKit `Source/WebCore/page/EventSource.cpp` (main), <https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/EventSource.cpp> |
| [WK-RR] | WebKit `Source/WebCore/platform/network/ResourceRequestBase.cpp` (main) |
| [APPLE-URLSESSION] | Apple docs, `URLSessionConfiguration.httpMaximumConnectionsPerHost` |
| [APPLE-FORUM-765183] | Apple Developer Forums thread 765183, "EventSource: event 'error' not fired in iOS18" (Oct 2024; no Apple response) |
| [RFC9113] | RFC 9113 HTTP/2, §6.5.2 `SETTINGS_MAX_CONCURRENT_STREAMS` |
| [NODE-GLOBALS] | Node.js docs, Globals › `EventSource`, <https://nodejs.org/api/globals.html> |
| [NODE-HTTP] | Node.js docs, `http.maxHeaderSize`, <https://nodejs.org/api/http.html> |
| [NGINX] | nginx `large_client_header_buffers`, <https://nginx.org/en/docs/http/ngx_http_core_module.html> |
| [UNDICI-ES] | undici `lib/web/eventsource/eventsource.js` and `docs/docs/api/EventSource.md` (main) |
| [UNDICI-TEST] | Local experiment, Node v25.9.0 with `--experimental-eventsource`, scripts in appendix |
| [FES] | `@microsoft/fetch-event-source` 2.0.1, `src/fetch.ts`, `src/parse.ts`, <https://github.com/Azure/fetch-event-source> |
| [ESPKG] | `eventsource` 5.1.1, `src/EventSource.ts`, <https://github.com/EventSource/eventsource> |
| [ESPARSER] | `eventsource-parser` 4.1.0 README, <https://github.com/rexxars/eventsource-parser> |
| [CANIUSE] | caniuse `eventsource.json` (GitHub `Fyrd/caniuse`) |
| [WHATWG-503] | whatwg/html issue #503, reconnect URL after redirect (closed 2016-01-12) |
| [BUNDLE] | Local measurement, esbuild 0.28.2, `--bundle --minify --format=esm --platform=browser`, gzip -9 |

Where a claim is read from engine source but not exercised in a browser, it is marked *(from source, not exercised)*.

## 1. The native contract

### 1.1 The request

Per [SPEC] §9.2.2, the constructor builds a "potential-CORS request" with CORS attribute state *Anonymous*, or *Use Credentials* when `withCredentials: true`; cache mode `"no-store"`; initiator type `"other"`; user agents *may* add `Accept: text/event-stream`. The method is GET and cannot be changed; there is no way to set headers or a body.

Credentials concretely ([CR-ES] `Connect()`, [WK-ES] `connect()`, [ESPKG] `#getRequestOptions`, [UNDICI-ES] §CORS constants): mode `cors`; credentials mode `same-origin` by default, `include` with `withCredentials`. So same-origin cookies are always sent; cross-origin cookies only with `withCredentials: true`, which in turn requires `Access-Control-Allow-Credentials: true` and a non-wildcard `Access-Control-Allow-Origin`.

**No preflight, even with `Last-Event-ID`.** [FETCH] §4.1 only runs a CORS-preflight when the request's *use-CORS-preflight flag* is set or its *unsafe-request flag* is set together with a non-safelisted method/header; the unsafe-request flag "is set by APIs such as `fetch()` and `XMLHttpRequest`", not by `EventSource`. Chromium and WebKit make this explicit with `CorsPreflightPolicy::kPreventPreflight` / `PreflightPolicy::Prevent` ([CR-ES], [WK-ES]). Consequence: a `fetch()`-based client that sets `Last-Event-ID` (not a CORS-safelisted header) on a cross-origin request **will** trigger a preflight, native `EventSource` will not. For next-sse this only matters if the SSE route lives on a different origin than the app; same-origin is the default posture.

All three engines send `Accept: text/event-stream`. WebKit additionally sends `Cache-Control: no-cache` ([WK-ES]).

### 1.2 Response validation

[SPEC] §9.2.2: "if res's status is not 200, or if res's `Content-Type` is not `text/event-stream`, then fail the connection." Otherwise "announce the connection" (`readyState` → `OPEN`, fire `open`).

Engine details:

- Chromium requires status 200 and MIME type exactly `text/event-stream`; if a charset is present it must be UTF-8 (case-insensitive), otherwise the connection is aborted with a console error ([CR-ES] `DidReceiveResponse`).
- WebKit: status must be 200; MIME compared case-insensitively; a non-UTF-8 charset only logs a warning and decodes as UTF-8 anyway ([WK-ES] `didReceiveResponse`).
- Firefox: `httpStatus != 200` or content type not `text/event-stream` → fail ([FF-ES] `OnStartRequest`).
- undici/Node: parses the MIME type and compares `essence === 'text/event-stream'`; status must be 200 ([UNDICI-ES]).

`Content-Type: text/event-stream; charset=utf-8` is therefore the safe header. Note `204` is just another non-200 and is fatal (the W3C text that made 204 a "stop reconnecting" signal is gone from [SPEC]; `eventsource` npm still special-cases it for the error message only, [ESPKG]).

### 1.3 `readyState` and events

[SPEC] §9.2.2: `CONNECTING` (0) "not yet established, or it was closed and the user agent is reconnecting"; `OPEN` (1); `CLOSED` (2) "not open, and the user agent is not trying to reconnect. Either there was a fatal error or `close()` was invoked."

- *announce the connection*: `readyState = OPEN`, fire `open`.
- *reestablish the connection*: `readyState = CONNECTING`, fire `error`, wait the reconnection time, refetch.
- *fail the connection*: `readyState = CLOSED`, fire `error`; "Once the user agent has failed the connection, it does not attempt to reconnect."

The `error` event is a plain `Event`; [SPEC] §9.2.10 admits "little to no information can be made available in the events themselves." **The only way to tell a transient error from a fatal one is to read `readyState` inside the `error` handler** (verified in Node, [UNDICI-TEST]: `error readyState=0` before a retry, `error readyState=2` after a 503).

### 1.4 Reconnection and `retry`

[SPEC] §9.2.3, "reestablish the connection": wait "a delay equal to the reconnection time", then *optionally* "wait some more. In particular, if the previous attempt failed, then user agents might introduce an exponential backoff delay", or wait for the OS to report connectivity. The reconnection time "must initially be an implementation-defined value, probably in the region of a few seconds."

The `retry` field ([SPEC] §9.2.6): "If the field value consists of only ASCII digits, then interpret the field value as an integer in base ten, and set the event stream's reconnection time to that integer. Otherwise, ignore the field." It is stream-level state, applies to the *next* reconnect, and persists across reconnects on the same object (Chromium keeps `reconnect_delay_` on the `EventSource`, not the parser, [CR-ES]).

What engines actually do:

| Engine | Default | Clamping | Backoff | Empty `retry:` |
| --- | --- | --- | --- | --- |
| Chromium | 3000 ms (`kDefaultReconnectDelay`) | none (uint64; `retry: 0` means immediate) | none: fixed one-shot timer | resets to 3000 ([CR-PARSER]) |
| WebKit | 3000 ms (`defaultReconnectDelay`) | none | none | resets to 3000 ([WK-ES]) |
| Firefox | 5000 ms (pref `dom.serverEvents.defaultReconnectionTime`) | min 500 ms (`MIN_RECONNECTION_TIME_VALUE`), max `PR_IntervalToMilliseconds(DELAY_INTERVAL_LIMIT)` | none | ignored (not all digits) ([FF-ES], [FF-PREFS]) |
| undici / Node | 3000 ms (`defaultReconnectionTime`; overridable via `node.reconnectionTime`) | none | none | per spec ([UNDICI-ES]) |

None of the engines implement the optional backoff. With a fixed delay, a fleet of clients whose server keeps returning 200 and closing will retry in lock-step every 3 s forever; if the server instead returns 5xx they all stop forever (§1.5). The server can steer the delay with `retry:`, but only on a successful stream, which is exactly when it matters least.

**The reconnect timer is not subject to background-tab timer throttling in Chromium.** The `EventSource` connect timer runs on `TaskType::kRemoteEvent`, which `FrameSchedulerImpl::CreateQueueTraitsForTaskType` maps to `DeferrableTaskQueueTraits()` ("these are unthrottled"), whereas `kJavascriptTimerDelayedLowNesting/HighNesting` (DOM timers) get `ThrottleableTaskQueueTraits()` and intensive throttling ([CR-SCHED], [CR-THROTTLE]). A JS-implemented reconnect loop (any fetch-based client) uses DOM timers and is throttled to one wake-up per minute after 5 minutes hidden when its timer chain count is 5 or more ([CR-THROTTLE]).

### 1.5 Failure matrix

Spec rules ([SPEC] §9.2.2 and §9.2.3):

- response is an *aborted* network error → fail;
- response is any other network error → reestablish "unless the user agent knows that to be futile";
- non-200 or wrong `Content-Type` → fail;
- `processResponseEndOfBody`: when the body ends and the response "is not a network error" → reestablish.

| Situation | Spec | Chromium [CR-ES] | Firefox [FF-ES] | WebKit [WK-ES] | Node/undici [UNDICI-ES], [UNDICI-TEST] |
| --- | --- | --- | --- | --- | --- |
| Server ends a 200 stream cleanly | reestablish | `DidFinishLoading` → `ScheduleReconnect` | `OnStopRequest` success → `ReestablishConnection` | `didFinishLoading` → `scheduleReconnect` | reconnects after 3 s, sends `Last-Event-ID` (verified) |
| TCP reset / drop mid-stream | reestablish | `DidFail` (not cancellation, not access check) → reconnect | reconnects only for an allowlist of codes: `CONNECTION_REFUSED`, `NET_TIMEOUT`, `NET_RESET`, `NET_INTERRUPT`, `NET_PARTIAL_TRANSFER`, `NET_TIMEOUT_EXTERNAL`, `PROXY_CONNECTION_REFUSED`, `DNS_LOOKUP_QUEUE_FULL`, `INVALID_CONTENT_ENCODING`; **any other failure (e.g. `NS_ERROR_UNKNOWN_HOST`, offline) fails the connection** *(from source, not exercised)* | `didFail` → reconnect | reconnects after 3 s (verified) |
| Connection refused / DNS failure on (re)connect | reestablish unless futile | reconnect | refused → reconnect; unknown host → fail *(from source)* | reconnect | reconnect |
| 4xx or 5xx | fail | `loader_->Cancel()` → `AbortConnectionAttempt` → `CLOSED` | `DispatchFailConnection` | `abortConnectionAttempt` | `CLOSED`, no retry (verified with 503) |
| 200 with wrong `Content-Type` | fail | fail + console error | fail | fail + console error | fail |
| 3xx redirect | followed by fetch; final response evaluated; event `origin` is the post-redirect origin | followed; reconnects to the post-redirect URL (`current_url_ = response.CurrentRequestUrl()`) | followed; `mSrc` updated only on `REDIRECT_PERMANENT` (301/308), temporary redirects reconnect to the original URL *(from source)* | followed; reconnects to the original `m_url` | `redirect: 'follow'` |
| CORS failure | network error → (practically) fail | `IsAccessCheck()` → abort | `NS_ERROR_DOM_SECURITY_ERR` → fail | `isAccessControl()` → abort | fail |
| `close()` | `CLOSED`, abort fetch, no event | same | same | same | same |
| `window.stop()` | aborted network error → fail | `IsCancellation()` → abort, fires `error` | fail (console error suppressed) | `isWindowStopping` → `CLOSED` + `error` | n/a |
| Document destroyed | forcibly close: abort fetch, `CLOSED` | `ContextDestroyed` → `close()` | `Close` | `stop` → `close` | n/a |

Historical note: [SPEC-W3C-2015] §6 said "HTTP 500 Internal Server Error, 502 Bad Gateway, 503 Service Unavailable, and 504 Gateway Timeout responses, and any network error that prevents the connection from being established in the first place (e.g. DNS errors), must cause the user agent to asynchronously reestablish the connection", and that 204 stops reconnection. The current [SPEC] has neither rule, and no engine implements the old one. (I did not locate the exact WHATWG commit that dropped the 5xx rule; the behaviour is established from the current spec text plus all four implementations.)

On redirects: [WHATWG-503] (annevk, 2016-01-12) confirms the spec's intent is that reconnects reuse the request, whose *current URL* is the last entry of its URL list, i.e. the post-redirect URL. Chromium matches; WebKit does not; Firefox only for permanent redirects. **Do not rely on redirects in the SSE route**; in particular a redirect to a login page turns into a fatal non-`text/event-stream` response anyway.

### 1.6 Server-initiated close vs network drop

Both go through *reestablish the connection*: `readyState → CONNECTING`, `error` fired, same delay. There is no field on the event, no close code, no status. [UNDICI-TEST] shows identical client output for "server calls `res.end()`" and "server destroys the socket". Only the partial block differs: the spec discards "any pending data" at end of stream, so an event that lost its trailing blank line is dropped and **its `id` is not applied** (verified: after a drop mid-block `id: 1-b`, the reconnect sent `Last-Event-ID: 1-a`).

If the server wants the client to know it closed on purpose, it must say so in-band (a final event before closing) or through the reconnect request (the client sees the next `open`). The client core should not try to infer intent from the `error` event.

## 2. `Last-Event-ID` and the `id` field as a cursor

### 2.1 What sets, resets and sends it

[SPEC] §9.2.6, field processing: "If the field name is `id`: If the field value does not contain U+0000 NULL, then set the last event ID buffer to the field value. Otherwise, ignore the field."

Dispatch steps (browser): step 1 "Set the last event ID string of the event source to the value of the last event ID buffer. The buffer does not get reset, so the last event ID string of the event source remains set to this value until the next time it is set by the server." Then, only if the data buffer is non-empty, a `MessageEvent` is created whose `lastEventId` is the event source's last event ID string.

Consequences:

- The last event ID is **per-`EventSource` object (stream-level), not per-event**. Every `MessageEvent.lastEventId` reflects the most recent `id` seen, including for events that carried no `id` field ("the event's `lastEventId` field will be set to the value of whatever the last seen `id` field was", [SPEC] §9.2.6).
- **Per spec, a block with `id:` but no `data:` updates the cursor without dispatching anything** (step 1 runs before the empty-data check). Chromium does exactly this: `last_event_id_ = id_` on every blank line, dispatch only `if (!data_.empty())` ([CR-PARSER]). **Firefox and WebKit do not** *(from source, not exercised)*: WebKit only calls `dispatchMessageEvent()` when `m_data` is non-empty and only there moves `m_currentlyParsedEventId` into `m_lastEventId`, so an id-only block is applied at the *next* data event, not before ([WK-ES] `parseEventStreamLine`, `dispatchMessageEvent`); Firefox's `DispatchCurrentMessageEvent` clears the fields and returns early when `mData` is empty, and `mLastEventID` is only assigned while dispatching a queued message, so the id of a data-less block is **dropped** ([FF-ES]). Consequence: **do not use id-only blocks to advance the cursor** (e.g. as keepalives); a reconnect from Firefox or Safari would resume from the last *data* event's id. Use comment lines for keepalives and put ids only on real events.
- An **empty `id` field resets the cursor to the empty string**, after which "no `Last-Event-ID` header will now be sent" ([SPEC] §9.2.6 example). `eventsource-parser` reports it as an empty string via `onId` ([ESPARSER]); `@microsoft/fetch-event-source` deletes the header ([FES]).
- The header is sent **only in the reestablish algorithm**, and only "If the EventSource object's last event ID string is not the empty string" ([SPEC] §9.2.3 step 5.3; Chromium `if (parser_ && !parser_->LastEventId().empty())`, [CR-ES]; WebKit `if (!m_lastEventId.isEmpty())`, [WK-ES]; Firefox `if (mLastEventID.IsEmpty()) return`, [FF-ES]). **The first request of an object never carries it**, and there is no API to seed it. A new `EventSource` starts with an empty string ([SPEC] §9.2.2 "A last event ID string. This must initially be the empty string").
- The value is carried across reconnects of the same object (Chromium: "The new parser takes over the event ID", [CR-ES]).

### 2.2 Value space and size

[SPEC] §9.2.4: "It is essentially any UTF-8 encoded string, that does not contain U+0000 NULL, U+000A LF, or U+000D CR" (whatwg/html issue #7363 is open to define it better). It is sent as a single HTTP header, so the practical limit is header-size policy on the receiving side, not the browser:

- Node: `http.maxHeaderSize` "Defaults to 16 KiB. Configurable using the `--max-http-header-size` CLI option" ([NODE-HTTP]); that is the total for all headers of a request.
- nginx: `large_client_header_buffers 4 8k` by default; "A request header field cannot exceed the size of one buffer as well, or the 400 (Bad Request) error is returned" ([NGINX]).

No browser-side cap on the `id` value was found in [CR-PARSER], [WK-ES] or [FF-ES]. A cursor of a few hundred bytes is safe; a cursor that grows with the number of Channels (e.g. one offset per Channel) needs a design limit. Firefox 6+/Chrome 6+/Safari 5+/iOS 4+/Edge 79+ all support the API ([CANIUSE]), so there is no compatibility reason to avoid the header.

### 2.3 What this means for a cursor design

- The client core must **track the cursor itself** from `MessageEvent.lastEventId`, because the native state dies with the object and is never sent on first connect.
- The server must accept the cursor from **two places**: the `Last-Event-ID` header (browser-driven reconnects) and the URL (first connect with a server-rendered cursor, core-driven reconnects after fatal errors, Channel-set changes). When both are present the header is newer or equal, since it is set only after the URL was fixed at construction time; the server should prefer the header.
- Because a non-200 response is fatal and a redirect is unreliable, the server must answer an **unusable cursor (too old for the replay buffer) with a 200 stream** that says so in-band (e.g. a `reset` event), not with a 4xx.
- Because a dropped block does not advance the cursor, the replay buffer must be keyed by the cursor of the last *complete* block; that is the natural behaviour if ids are assigned per Message.

## 3. Page lifecycle: backgrounding, bfcache, visibility

The Page Visibility API says nothing about network connections; what follows is per engine.

**Chromium, hidden tabs.** Timer throttling affects DOM timers only ([CR-THROTTLE]); the native reconnect timer is unthrottled ([CR-SCHED], §1.4). The Page Lifecycle guidance for `freeze` is to "Stop any network polling or close any open Web Socket connections" and on `resume` to reopen them ([CR-LIFECYCLE]); a *discarded* tab is fully unloaded and reloads from scratch on activation, so the client reconnects with whatever cursor the page can recover (server-rendered data), not the one it had.

**Chromium, bfcache.** `features::kLoadingTasksUnfreezable` is `FEATURE_ENABLED_BY_DEFAULT` ([CR-BFC] `features.cc`), so `ResourceLoader` does **not** register an outstanding-request blocker for in-flight loads (`resource_loader.cc`: the `RegisterFeature(kOutstandingNetworkRequest…)` call is skipped when `IsInflightNetworkRequestBackForwardCacheSupportEnabled()`), and `EventSource` itself registers no blocking feature ([CR-ES]). Instead the loader is frozen in `kBufferIncoming` mode: incoming bytes are buffered, a per-process budget of `1024 * 1000` bytes applies (`kDefaultMaxBufferedBodyBytesPerProcess`), exceeding it evicts the page (`kNetworkExceedsBufferLimit`), and a timer evicts the page after `grace_period_to_finish_loading_in_seconds` = 60 s if the load has not completed (`kNetworkRequestTimeout`) ([CR-BFC] `mojo_url_loader_client.cc`, `back_forward_cache_buffer_limit_tracker.cc`). Net effect: a page with an open stream goes into bfcache, and unless the server closes the stream within 60 s it is evicted, i.e. the user gets a full reload on back navigation. `WebSocket`, `WebRTC` and `WebTransport` stay on the always-disallowed list ([CR-BFC] `GetDisallowedWebSchedulerTrackedFeatures`); [WEBDEV-BFC] says the same and recommends closing connections in `pagehide`/`freeze` and reopening in `pageshow`/`resume`.

**WebKit.** `EventSource::suspend(BackForwardCache)` asserts "Loads get cancelled before entering the BackForwardCache"; `didFail` with a cancellation that is not explicit and not `window.stop()` sets `m_shouldReconnectOnResume`; `resume()` then `scheduleReconnect()` ([WK-ES]). So Safari keeps the page in bfcache, silently drops the stream, and reconnects (with `Last-Event-ID`) on restore. No `error` event is fired at cancellation time. *(from source, not exercised)*

**Firefox.** `EventSourceImpl` creates its channel in the document's load group (`doc->GetDocumentLoadGroup()`, [FF-ES]), and `Document::CanSavePresentation` blocks bfcache when the load group holds any request other than the navigation's (`BFCacheStatus::REQUEST`, "Save of %s blocked because document has request %s", [FF-DOC]). The `Freeze`/`Thaw` code in [FF-ES] therefore only applies when the stream is between reconnects. *(from source, not exercised)*

**iOS Safari.** No Apple documentation was found. [APPLE-FORUM-765183] (Oct 2024, unanswered by Apple) reports that on iOS 18, after a PWA is backgrounded for more than ~20 s the server-side connection closes but the `EventSource` stays at `readyState === 1` and never fires `error`, whereas iOS 17 fired `error` on return. Treat as **unverified but plausible**: the client core should not trust `readyState` after `visibilitychange` to visible and should proactively reconnect (or at least expect a heartbeat within a bounded time).

Practical rule for the core: on `pagehide`/`freeze` close the stream; on `pageshow`/`resume`/`visibilitychange` to visible, reconnect from the tracked cursor. This keeps Chromium pages bfcache-eligible without the 60 s eviction, sidesteps the Firefox blocker, and covers the iOS zombie case. `@microsoft/fetch-event-source` does a cruder version of this by default (abort on every `visibilitychange`, reopen when visible, [FES]).

## 4. Per-host connection limits

**HTTP/1.1.** Chromium: `g_max_sockets_per_group = { 6 /* kNormal */, 255 /* kWebSocket */ }` with the comment "Default to allow up to 6 connections per host" ([CR-SOCKET]). Firefox: `network.http.max-persistent-connections-per-server` = 6 ([FF-PREFS] `all.js`). Both bugs asking for more for `EventSource` are WontFix: Chromium crbug.com/275955 (as cited by [MDN-ES]; not re-verified on the new tracker), Firefox 906896 ([FF-BUG-906896], verified via the Bugzilla API). Safari's limit is not documented; the only Apple number is the `URLSession` default of 6 per host ([APPLE-URLSESSION]), and WebKit's non-Cocoa fallback is 4 ([WK-RR] `initializeMaximumHTTPConnectionCountPerHost`). The limit is per browser profile and host, shared across tabs: [MDN-ES] warns that with six tabs open to one origin, every further request to that origin stalls. [SPEC] §9.2.7 suggests unique hostnames per connection, per-page opt-out, or "sharing a single `EventSource` object using a shared worker".

**HTTP/2.** Requests to one origin multiplex on one connection; the number of concurrent streams is the server's `SETTINGS_MAX_CONCURRENT_STREAMS`: "Initially, there is no limit to this value. It is recommended that this value be no smaller than 100" ([RFC9113] §6.5.2). Firefox's own default for the value it advertises is 100 (`network.http.http2.default-concurrent`, [FF-PREFS]). [MDN-ES]: "When using HTTP/2, the maximum number of simultaneous HTTP streams is negotiated between the server and the client (defaults to 100)."

For next-sse: one Connection per tab (settled in the map) is the right shape; the HTTP/1.1 budget is shared with every image and fetch on the same origin, so documentation must tell self-hosters to front Next.js with an HTTP/2-capable proxy (whether `next start` itself can serve HTTP/2 was not established here; see open questions).

## 5. Fetch-based alternatives

Sizes measured locally ([BUNDLE]); versions and dates from the npm registry on 2026-08-23.

| | Native `EventSource` | `@microsoft/fetch-event-source` 2.0.1 | `eventsource` 5.1.1 | `eventsource-parser` 4.1.0 |
| --- | --- | --- | --- | --- |
| Last publish | n/a | 2021-04-25 | 2026-08-20 | 2026-08-20 |
| Bundle (min / gzip) | 0 | 2.4 KB / 1.26 KB | 8.9 KB / 3.5 KB (includes parser) | `createParser` 4.3 KB / 1.75 KB; `EventSourceParserStream` 4.7 KB / 1.9 KB |
| Custom headers / method / body | no | yes (`RequestInit`) | via `fetch` option wrapper | n/a (parser only) |
| Cross-origin `Last-Event-ID` without preflight | yes | no (plain header) | no | n/a |
| Sees HTTP status / response | no | yes (`onopen(response)`) | `ErrorEvent` with `code` and `message` | n/a |
| Reconnect on clean server close | yes | **no**: `onclose` then resolves; retry only if `onclose` throws | yes (spec) | n/a |
| Reconnect on network error | yes | yes, default 1000 ms, `onerror` may return a delay or throw to stop | yes, 3000 ms | n/a |
| Reconnect on 4xx/5xx | no (fatal) | default `onopen` only checks `content-type`; a 404 HTML page is retried every 1 s until `onopen` throws | no (fatal, spec) | n/a |
| Backoff | no | no built-in; `onerror` return value | no | n/a |
| Honours `retry:` | yes | yes | yes | reports via `onRetry` |
| `Last-Event-ID` | automatic, object-scoped, never on first request | automatic on retries; **can be seeded** by passing the header initially | automatic, spec semantics | reports via `onId` |
| Visibility handling | none | aborts on every `visibilitychange`, reopens when visible, unless `openWhenHidden` | none | n/a |
| Node support | Node 22.3+/20.18+ behind `--experimental-eventsource` ([NODE-GLOBALS]); `typeof EventSource === 'undefined'` without the flag on v25.9 ([UNDICI-TEST]) | **no**: uses `document`, `window.fetch`, `window.setTimeout` unconditionally ([FES]) | yes, `engines.node >= 22.12.0` | yes, `>= 22.12` |
| Parser fidelity | spec | `retry` via `parseInt` (accepts `3000abc`); `id` with NULL not ignored; `onmessage` fires an empty message for comment-only blocks (every blank line dispatches) ([FES] `parse.ts`) | uses `eventsource-parser` | spec, plus `maxBufferSize`, `onError` for `unknown-field`/`invalid-retry` ([ESPARSER]) |

Notes:

- `eventsource` (npm) is the best reference for "what a spec-faithful client looks like in TypeScript": fixed 3 s delay, `mode: 'cors'`, `redirect: 'follow'`, `cache: 'no-store'`, credentials `same-origin`/`include`, reconnects to the original URL, `DEFAULT_MAX_BUFFER_SIZE = 100 MiB`, timer `unref()`ed in Node ([ESPKG]). Its `fetch` hook is enough to add an `Authorization` header. It fails permanently on 5xx like a browser does.
- `@microsoft/fetch-event-source` is unmaintained since 2021, browser-only, and changes two semantics silently (no reconnect on clean close, abort on visibility change). Its small size comes from doing less.
- `eventsource-parser` is the component worth reusing if the core ever parses streams itself (Node tests, a future fetch Transport): it handles the `id`/NULL, empty-`id`, `retry` digit rules and exposes `onId` separately from `onEvent`, which is exactly the "id-only block advances the cursor" semantics of §2.1.
- Node's built-in `EventSource` is undici's: flag-gated, emits an `ExperimentalWarning` (`UNDICI-ES`), accepts `node.dispatcher` (for proxies or injecting headers through an interceptor) and `node.reconnectionTime`, and `maxEventSize` on the dispatcher ([UNDICI-ES]). Behaviour matches browsers on close/drop/5xx ([UNDICI-TEST]). Good enough for integration tests with the flag; not something to ship in a library's runtime path.

## 6. Gap analysis against the hard requirement

"No Message lost or duplicated across a reconnect, nor between a server component rendering initial data and the Connection being live."

| Need | Native `EventSource` provides | Gap |
| --- | --- | --- |
| Resume after a browser-driven reconnect | `Last-Event-ID` from the last complete block | none, provided the server replays from the cursor |
| Resume from a server-rendered snapshot (initial data) | nothing: first request has no `Last-Event-ID` | cursor must go in the URL; server must honour it |
| Resume after a fatal error (4xx/5xx, wrong content type, CORS, Firefox DNS failure) | nothing: `CLOSED`, state discarded | core must keep the cursor, back off, construct a new object with the cursor in the URL |
| Resume after a Channel-set change (new Connection by design) | nothing | same as above |
| Resume after bfcache restore / tab resume / iOS zombie | Chromium: eviction after 60 s; WebKit: silent reconnect; Firefox: bfcache blocked; iOS: possibly stale `OPEN` | core should close on hide and reconnect on show from its own cursor |
| Detect silent death (proxy idle timeout, iOS) | nothing | server heartbeat + client watchdog |
| Avoid duplicate delivery | `lastEventId` on every event | core should drop events with ids at or before its cursor, if ids are totally ordered; otherwise the server must not replay the boundary event |
| Backoff / jitter | none; fixed 3 s or 5 s | core can only influence via server `retry:`; for core-driven reconnects it owns the timer (and is throttled in background tabs) |
| Auth expiry (cookie expired → 401) | fatal, no retry | core must treat `CLOSED` as "reconnect with policy", and the server should prefer a 200 stream with an in-band `unauthorized` event over a 401 when it wants the client to stop cleanly |
| Server-initiated close for rolling deploys | reconnect after 3–5 s with `Last-Event-ID` | acceptable; the server can send `retry:` first to spread the thundering herd |

## 7. What the client core can rely on natively vs what it must implement itself

**Rely on natively (same-origin, native `EventSource`):**

1. Cookies sent automatically; no preflight; no headers to manage.
2. UTF-8 decoding, line/field parsing, `event`/`data`/`id`/`retry` semantics; incomplete trailing blocks are discarded, never half-delivered.
3. Automatic reconnect with `Last-Event-ID` after a 200 stream ends for any reason, with an unthrottled timer, on every supported browser (Chrome 6+, Firefox 6+, Safari 5+).
4. `readyState` as the fatal/transient discriminator inside `error` handlers.
5. `MessageEvent.lastEventId` on every event, so the cursor can be mirrored in JS at no cost.
6. `retry:` as a server-side knob for the delay of the *next* reconnect.

**Implement in the core:**

1. **Cursor ownership**: store the last *applied* cursor (from `lastEventId` or the initial server-rendered value); pass it in the URL on every object construction; prefer the header on the server when both exist.
2. **Fatal-error recovery**: on `error` with `readyState === CLOSED` (and not user-initiated `close()`), schedule a new `EventSource` with exponential backoff and jitter, capped; surface an `onError`-style hook so the app can stop (e.g. on auth loss). Remember this timer *is* throttled in background tabs; prefer reconnecting on visibility change rather than on a long background timer.
3. **Visibility/lifecycle handling**: close on `pagehide`/`freeze`/hidden (policy-configurable), reconnect on `pageshow`/`resume`/visible. This is also the fix for Chromium's 60 s bfcache eviction and the iOS stale-`OPEN` report.
4. **Liveness watchdog**: the server sends a comment line every ~15 s ([SPEC] §9.2.7 recommends comments every 15 s for proxies; not an `id`-only block, see §2.1); the core closes and reconnects if nothing arrives within N × interval. Native `EventSource` has no timeout, and comments are invisible to JS, so the watchdog needs either a real heartbeat *event* or a server-side guarantee that the proxy chain does not time out. Decide in the wire-format ticket; a tiny `heartbeat` event without an `id` is the simplest.
5. **Deduplication at the boundary**: ignore events whose id is not after the cursor (requires totally ordered ids per Connection, which the server design must guarantee or the core must not dedupe).
6. **In-band control events** (`reset`/cursor-too-old, `unauthorized`, `goaway` before a deploy) because the transport offers no out-of-band signalling and non-200 responses are one-way doors.
7. **Single-Connection enforcement** across the app (one `EventSource` per tab, reference-counted across hooks), because the HTTP/1.1 budget is 6 per host shared with everything else.
8. **Channel-set changes** as a deliberate reconnect with the cursor in the URL.

**Deliberately not implemented in v0.1:** a fetch-based Transport (headers-based auth; listed under "Not yet specified" in the map). When it comes, use `eventsource-parser` for parsing and copy the reconnect semantics of `eventsource` (npm), and document that cross-origin `Last-Event-ID` then costs a preflight.

## 8. Open questions

1. **`next start` and HTTP/2**: whether a self-hosted Next.js 16.3 server can serve HTTP/2 itself or always needs a proxy for it. Not established here; affects the connection-limit guidance in the docs.
2. **Firefox bfcache with an open stream**: the blocking path was read from `Document.cpp` and `EventSource.cpp` but not exercised; a Playwright check on Firefox would settle it.
3. **iOS Safari stale `OPEN`**: only a developer-forum report ([APPLE-FORUM-765183]); needs a device test. If real, the watchdog in §7 is the only defence.
4. **Cursor semantics**: one global, totally ordered cursor per Connection (simple dedupe, large replay fan-in) versus a per-Channel vector (bounded by header size, §2.2). This is the Transport/wire-format ticket's decision; the constraint from this research is "must fit comfortably in one header and one query parameter".
5. **Policy for core-driven reconnects after auth failure**: retry a few times with backoff and then surface, or surface immediately. Needs the Authorize ticket's view of what a denied Channel looks like on the wire (a 200 stream with an `unauthorized` event is the only way to deliver a reason).
6. **Firefox's network-error allowlist**: whether `NS_ERROR_UNKNOWN_HOST`/offline truly fails the connection today (bug 831392 was FIXED in the past for a related case). Matters for the "laptop lid closed" scenario; the fatal-error recovery in §7 covers it either way.
7. **The exact WHATWG commit that removed the 5xx-reconnect rule** was not located; the current normative text and all four implementations agree, so this is only a citation gap.

## Appendix: Node experiment ([UNDICI-TEST])

Node v25.9.0, `node --experimental-eventsource client.mjs` against a local `http` server on port 4567. Three modes: `clean` (server writes two events then `res.end()`), `drop` (server writes one complete event, then a partial block `id: N-b\ndata: partial` and destroys the socket), `503` (second request answered with 503).

Observed (times relative to client start):

```
drop:   open → message id=1-a → error readyState=0 → +3 s open (server saw Last-Event-ID: 1-a) → ...
clean:  open → message id=1-a → message id=1-b → error readyState=0 → +3 s open (Last-Event-ID: 1-b) → ...
503:    open → message id=1-a → error readyState=0 → +3 s error readyState=2, no further requests
```

Scripts:

```js
// server.mjs
import http from 'node:http';
let n = 0;
const mode = process.argv[2];
http.createServer((req, res) => {
  n++;
  console.log(`[server] req#${n} Last-Event-ID=${req.headers['last-event-id'] ?? '<none>'}`);
  if (mode === '503' && n === 2) { res.writeHead(503); res.end('down'); return; }
  res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'});
  res.write(`id: ${n}-a\ndata: hello\n\n`);
  setTimeout(() => {
    if (mode === 'clean') { res.write(`id: ${n}-b\ndata: bye\n\n`); res.end(); }
    else { res.write(`id: ${n}-b\ndata: partial`); req.socket.destroy(); }
  }, 300);
}).listen(4567);

// client.mjs
const es = new EventSource('http://localhost:4567/');
const t0 = Date.now();
const log = (m) => console.log(`[client +${Date.now() - t0}ms] ${m} readyState=${es.readyState}`);
es.onopen = () => log('open');
es.onmessage = (e) => log(`message id=${e.lastEventId} data=${JSON.stringify(e.data)}`);
es.onerror = () => log('error');
```
