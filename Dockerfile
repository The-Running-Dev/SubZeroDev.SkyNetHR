# The deployment artifact (design/90-decisions.md, 2026-08-19 — "The deployment artifact
# borrows the host's authenticated Claude CLI"). Ships this server plus the `claude` CLI it
# spawns per turn (src/adapters/claude/index.ts) — no model credential is baked in here
# (design/00-brief.md's "Hosting the model" non-goal): the container expects the operator's
# own `claude` auth state bind-mounted in at run time.
#
# `client/` is not compiled by tsc (tsconfig.json's `include` is `src/**/*.ts` only) and is
# read at runtime relative to the compiled file's own location
# (`CLIENT_DIR = new URL('../../../client/', import.meta.url)`, src/edge/http-common/index.ts)
# — it must land beside `dist/`, not inside it, which is why it is copied separately below.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build: compile TypeScript -------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN find dist -name '*.test.js' -delete

# ---- deps: production-only node_modules, pruned from the build stage's own install ----
FROM build AS deps
RUN npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# The CLI this server drives (src/adapters/claude/index.ts spawns `claude` on PATH by
# default). Installed globally so it resolves the same way for every operator regardless
# of $HOME, which is left free for the credential bind mount below.
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY client ./client
COPY package.json ./package.json

ENV NODE_ENV=production

# Pre-create /data owned by `node`: a fresh Docker-managed volume mounted here (see
# docker-compose.yml's `skynet-hr-storage`) inherits the mount point's ownership from the
# image on first use, which is what makes STORAGE_ROOT writable by the non-root user below
# instead of landing root-owned.
RUN mkdir -p /data && chown node:node /data

# The base image's existing uid-1000 `node` user, not root — the workspace roots this
# process is jailed to (src/jail) are bind-mounted from the host, and the CLI credential
# directory below is read-write. `HOME` is where `claude` itself looks for its auth state
# (e.g. `~/.claude`); the compose files bind-mount the host operator's own credential
# directory over it rather than baking one in.
USER node
ENV HOME=/home/node

EXPOSE 3000

CMD ["node", "dist/server.js"]
