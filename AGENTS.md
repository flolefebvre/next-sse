# next-sse

## Context

This is the monorepo of `@flefebvre/next-sse`, a published library: typed, authorization-aware pub/sub over Server-Sent Events for the Next.js App Router. Its users are Apps and the agents that write them, so the public API, the manual that ships in the package and the shipped skill are the product as much as the code. Every change is judged as something every App will install.

## Stack

- TypeScript `strict`, ESM only, Node ≥ 22.12, pnpm workspace
- Peers: Next.js ≥ 16.3 (App Router), React ≥ 19.2; node-redis for the Redis Transport (Redis and Valkey)
- Vitest 4 as the only runner, testcontainers for Redis/Valkey, the Playwright library (not `@playwright/test`) for browser scenarios
- ESLint, Prettier, jscpd (copy/paste detection)
- tsx, for the repo scripts

## Layout

```
packages/next-sse/    The published package
  src/                One folder per subpath entry (server, client, transport, testing), plus internal/ (shared, never exported)
  docs/               The manual; ships in the tarball
examples/basic/       The example App: the e2e suite drives it, its own tests run against dist
e2e/                  Post-build scenarios, one per file, and their harness
tests/                Cross-module tests, the integration harness (Redis topologies, two Instances), the dist and worker consumers
scripts/              Repo tooling, run with tsx
skills/next-sse/      The agent skill shipped to Apps that use the library
docs/
  adr/                Decisions, numbered
  agents/             Agent-skill config: issue tracker, triage labels, domain docs
  codebase/           Conventions, one file per area, linked from the AGENTS.md section it governs
```

## Commands

The `test` step and the gate need Docker. If they fail because the Docker daemon is down, stop and tell the user: only they can start it, and the gate requires it by design (ADR-0009).

```
pnpm gate               The full check, the same as CI; needs Docker
pnpm test               unit + client + integration; needs Docker
pnpm test:unit          The node project, Docker-free
pnpm test:client        The jsdom project, Docker-free
pnpm test:integration   Transports and two-Instance scenarios on testcontainers
pnpm build              Build the package into packages/next-sse/dist
pnpm test:e2e           The post-build phase, e2e + example; build first
pnpm pack:check         Inspect the packed tarball and its exports map; build first
pnpm typecheck:dist     Typecheck the dist consumers and the example App; build first
pnpm format             Prettier, rewriting files in place
pnpm lint               ESLint, warnings are failures
pnpm duplication        jscpd; any clone is a failure
pnpm typecheck          TypeScript with no emit
```

## Verification

- check: `pnpm exec tsx scripts/gate.ts format:check+lint+duplication+typecheck,test:unit+test:client`
- gate: `pnpm gate`
- final: gate

Run `check` after each step and each fix; it passed only if the output ends with `--gate OK--`. A change is done when the pushed PR's `gate` check is green. A change that will not be pushed passes `pnpm gate` (ends with `--gate OK--`) once before it is handed over; later fixes re-run `check`. Any other ending is a failure, whatever the rest of the output says.

`scripts/gate.ts` takes `package.json` scripts: `,` separates stages run in order, `+` joins scripts run in parallel, their output printed as each finishes. Join only scripts that write nothing the other reads or writes: `build` empties `dist`, which `pack:check`, `typecheck:dist` and `test:e2e` read. `test` runs alone because the integration scenarios are load-sensitive. A new gate step goes on the `gate` line and into the CI job that matches what it needs: `checks` (Docker-free), `integration` (containers) or `e2e` (post-build).

## Testing

This project uses TDD. A unit test sits next to the file it tests. A test's suffix picks its Vitest project: `.test.ts` (node), `.client.test.tsx` (jsdom), `.integration.test.ts` (Docker), `.e2e.test.ts` (post-build); any test under `examples/` runs in the post-build `example` project, against `dist`. A scenario test is named after the behaviour it proves, as a sentence: `a-kick-crosses-instances.integration.test.ts`. Read ADR-0009 before adding a project, a topology or an e2e scenario.

## Documentation

Reach for documentation rather than working from memory: the files below first, then ctx7.

- `examples/basic/node_modules/next/dist/docs/01-app/` (Next.js is installed in the example App only): read it before touching the Next.js integration (the route handler, `SSEProvider`, the Snapshot handoff, the example App). This Next.js has breaking changes that your training data predates.

## Comments and docs

- Comments are `/** */` blocks that say why. `pnpm lint` fails on any `//` comment that isn't a directive.
- What Apps read is part of the API: the package README, its manual, `skills/next-sse/` and the `context7.json` rules. A change to behaviour or API updates every one of them that describes it, in the same change.
- A change that departs from an ADR amends it, or adds one that supersedes it, in the same change, naming the issue that drove it.

## Language

Prose in this repo (docs, comments, commit messages, issues) is written in English, whatever language the conversation uses.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `flolefebvre/next-sse`, managed through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label named after its role. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Keeping this file current

If your changes mandate an update to a section of this `AGENTS.md`, make the change. Do not add any sections on your own. How this file and `docs/codebase/` are written: `docs/codebase/agent-docs.md`.
