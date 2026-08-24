# The example app as one image, built from the workspace root: this app depends on the library
# by `workspace:*`, so the library is built here too. It is a single stage on purpose — the
# image is a reference for reading and for `compose.yaml`, not a production packaging exercise,
# and a reader comparing it to their own Dockerfile should see the four steps and nothing else.
#
# A real deployment adds what a real deployment adds: `output: "standalone"` in `next.config.ts`
# and a slim runtime stage, a non-root user, a pinned digest. None of that changes a line of how
# the library runs.
FROM node:22-alpine

RUN corepack enable

WORKDIR /workspace

# The manifests first, so a change to application code does not re-resolve the dependency tree.
# `tsconfig.json` comes along because the package's build config extends the workspace one.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/next-sse/package.json packages/next-sse/
COPY examples/basic/package.json examples/basic/
RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY examples/ examples/
RUN pnpm --filter @flefebvre/next-sse run build && pnpm --filter next-sse-example-basic run build

# `NEXT_SSE_PREFIX` and `REDIS_URL` are what make several containers one App: the Prefix is the
# namespace the log lives under, and two Apps sharing a server under one Prefix would deliver
# each other's Messages (ADR-0006). `compose.yaml` sets both.
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
EXPOSE 3000

WORKDIR /workspace/examples/basic

# `next start` handles `SIGTERM` itself and the library drains on it (ADR-0011): open SSE
# responses are ended with `reconnect`, the clients move to the surviving container, and the
# process exits instead of sitting out the orchestrator's grace period. Running Next.js
# directly, rather than under a package-manager script, is what lets the signal reach it.
CMD ["node_modules/.bin/next", "start"]
