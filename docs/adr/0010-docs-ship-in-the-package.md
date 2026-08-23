# Docs ship in the npm package; the agent skill is a pointer-only stub

The user-facing manual lives at `packages/next-sse/docs/` and ships in the npm package (`files: ["dist", "docs", "LICENSE"]`), so the documentation an agent reads inside `node_modules` is version-locked to the installed code by construction. There is no content-bearing agent skill: `skills/next-sse/SKILL.md` is a git-only stub holding a trigger description and one instruction — read `node_modules/@flefebvre/next-sse/docs/index.md` first. Consumers who don't install the skill add that same one line to their own `AGENTS.md`/`CLAUDE.md`; the README shows the exact line in a "For agents" section right after Install. Nothing prints at postinstall.

This diverges from both reference repos deliberately. next-pipe ships `dist` only and maintains a hand-rewritten skill condensation of `docs/`, which needs a version stamp, an "update the skill in the same PR" rule, and a "trust the installed `.d.ts` over the docs" escape hatch — three patches for the one disease of docs that can drift from the installed version. Docs in the package cannot drift, and a pointer stub has no content to go stale while keeping `npx skills add` discoverability and automatic triggering.

The split between product and process is physical: everything under `packages/next-sse/docs/` is the shipped manual; everything under the repo root `docs/` (adr, agents, codebase, research) is process and never ships. No `files` excludes are needed.

The shipped tree, one concept per file, written agent-first (short, example-dense, imperative) but readable by humans:

- `index.md` — the router: a which-job-loads-which-file table, the six-subpath import map, and the iron rules (no root import, reserved names, `next>=16.3.0`, Handles only). No version stamp: the adjacent `package.json` versions it.
- `core-concepts.md` — App, Instance, Channel, Connection, Cursor, Transport, and the gap-free delivery guarantee.
- `setup.md` — install, `initSSE`/`createSSE`, the route file, `<SSEProvider>`, zero-config vs factory; ends with a "Done when" checklist.
- `server.md`, `client.md`, `transport.md`, `testing.md` — one hand-written reference page per subpath entry (transport covers the contract, Memory, Redis and writing a custom Transport; testing covers `transportContract` and `FakeEventSource`). No generated typedoc.
- `wire-format.md` — the `{ v: 1, … }` envelope as the stable external-publisher contract promised by ADR-0006.
- `deployment.md` — proxy checklist (nginx and Caddy snippets, buffering off, HTTP/2, timeouts), a pointer to `examples/basic/compose.yaml` as the runnable reference, the multi-Instance story, a Vercel caveat box, and the SIGTERM limitation stated plainly with the proxy-drain workaround.
- `when-not-to-use-sse.md` — client→server messaging, request/response RPC, binary or huge payloads, message history as a feature, very high fan-out or sub-10 ms latency, environments that can't hold connections open; each names the alternative.
- `patterns/` — ten recipes: per-user notifications, per-entity updates, broadcast, server component + live takeover, optimistic sends, publishing from a worker (incl. raw envelope), kick, reset override, testing your app, custom transport. Every pattern page inlines its snippets (each page must stand alone for context7/agent consumption) and links the file in `examples/basic` that implements it; every pattern the docs show exists in the example app, so the e2e suite keeps the hand-maintained snippets honest.

The README is a thin gateway in next-pipe's shape, the one human-first narrative surface: Why (plain and factual — the problem is keeping an SSE stream alive in production: reconnects, messages missed during a redeploy, proxy buffering, heartbeats, and the window between server render and the stream going live — and the claim is gap-free delivery), Install (noting `redis` is a plain dependency), For agents, a four-step quickstart (define a channel with pattern + schema + authorize → `export const { GET } = sse.handlers` → publish from a server action → `sse.snapshot` in the Server Component + `useChannelState` in the client), Package map (six subpaths → doc links), Going further, License. **Docs voice, everywhere**: human and informative, no marketing copy, no adjectives doing work facts should do, and no naming of other products — the README describes the problem and what the library does, never a competitor.

`context7.json` is git-only and follows next-pipe's posture: `folders: ["packages/next-sse/docs"]`, excluding the repo-process folders and `AGENTS.md`/`CLAUDE.md`, with ~10 one-line rules (subpath imports only; version floors and ESM-only; Channel as the only primitive; config on `initSSE`, `createSSE` pure; Handles only, no generic publish; connect-time Authorize; reserved names; `redis` plain dependency with `REDIS_URL` zero-config; stable wire envelope; trust the installed `.d.ts` over docs on conflict).

This amends the map's destination: the "agent skill" deliverable becomes shipped agent-consumable docs plus the pointer stub.

## Considered Options

- A content-bearing skill à la next-pipe (SKILL.md + task files with "Done when" checklists): rejected — it is a second, hand-maintained condensation of the docs, the exact drift surface this decision removes. The one task-shaped artifact kept is `setup.md`'s closing checklist.
- No skill at all, paste-line only: viable, but a ten-line stub that can't go stale buys `npx skills add` discoverability and automatic triggering for free.
- Docs git-only (both reference repos' posture): rejected — the map made shipped docs a hard deliverable, and version-locking the manual to the installed package is the point.
- A self-contained manual README (cache-handler posture): rejected — it would duplicate the shipped docs; the README pitches and delegates.
- Naming alternatives in a "how is this different" section: rejected by standing preference — no product comparisons anywhere in the docs.
- Shipping `src` in the package (cache-handler posture): rejected; `dist` plus the shipped docs cover it.
- Generated API reference (typedoc): rejected — six small hand-written pages are cheaper, agent-greppable, and stylistically consistent.
