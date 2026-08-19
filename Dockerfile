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

# Pinned, and bumped deliberately. src/adapters/claude/index.ts drives this CLI over its
# `stream-json` wire schema and reports anything it does not recognise as
# `adapter_unknown_record`, so a floating version would let two builds of the same commit
# behave differently — and the image gate never drives a real turn, so nothing would catch
# it (.github/workflows/publish.yml).
ARG CLAUDE_CODE_VERSION=2.1.235

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
ARG CLAUDE_CODE_VERSION

# `git` because the shadow-git checkpoints (S6, D31) shell out to it per session
# (src/checkpoints/index.ts) — the slim base ships none, and without it every checkpoint
# fails ENOENT and the feature is silently dead in the only artifact that ships it.
# `tini` because of the CMD below: see the ENTRYPOINT comment.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tini \
 && rm -rf /var/lib/apt/lists/*

# The CLI this server drives (src/adapters/claude/index.ts spawns `claude` on PATH by
# default). Installed globally so it resolves the same way for every operator regardless
# of $HOME, which is left free for the credential bind mount below.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force

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

# Node must not be pid 1. Pid 1 has no default action for a signal it installs no handler
# for, so `docker stop` — and every `docker compose up -d` on a new `:latest`, which is the
# documented redeploy path — would discard SIGTERM and escalate to SIGKILL after the grace
# period, killing a turn mid-write. Pid 1 is also the reaper of last resort: the adapter
# spawns `claude` `detached` into its own process group (src/adapters/claude/index.ts), and
# anything that outlives it reparents here. `tini` forwards the signal and reaps; the
# handler in src/server.ts is what turns the forwarded SIGTERM into a clean close.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
