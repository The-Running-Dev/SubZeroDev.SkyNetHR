# SkyNet HR

A browser console for driving a coding agent CLI that runs on the machine holding the code.
Self-hosted, for a small group of trusted operators.

**Status: under implementation.** `src/` is the real server, built slice by slice against
`design/30-slices.md`; `spike/` is throwaway proof kept for reference, not the shipped
thing.

## Read in this order

| | |
|---|---|
| [`design/00-brief.md`](design/00-brief.md) | Problem, who it is for, **binding non-goals** |
| [`design/10-design.md`](design/10-design.md) | Architecture, prior-art findings, threat model, failure modes |
| [`design/20-contract.md`](design/20-contract.md) | Event envelope, routes, vendor mappings |
| [`design/30-slices.md`](design/30-slices.md) | Work breakdown, S1–S9, with acceptance criteria |
| [`design/90-decisions.md`](design/90-decisions.md) | Why each choice, and what was rejected |
| [`spike/README.md`](spike/README.md) | How to run it, and what it deliberately omits |

## The shape in one paragraph

A Node server owns one child agent process per session, driving it over the CLI's
stream-json protocol with stdin held open so tool-permission requests can be answered
interactively. Vendor-specific adapters translate each CLI's output into one neutral event
envelope; nothing above the adapter layer knows a vendor exists. Events reach the browser
over SSE with sequence numbers, so a refresh mid-turn replays rather than loses. Sessions
are jailed to configured workspace roots by resolved real path, and identity comes from a
reverse proxy rather than a login system we would have to write.

## What was interrogated to get here

| Source | Verdict |
|---|---|
| `Forks-Claude-Code-Chat@ab6e307` (local) | The Claude CLI transport, permission handshake and shadow-git checkpoints. Read for protocol, not copied |
| Open WebUI `v0.11.0` (local) | Not a base — a **host**. Its terminal-server proxy forwards `X-User-Id`, so it can supply accounts, groups, audit and rate limiting |
| `open-webui/computer` | Nearest existing thing, but calls model APIs rather than supervising agent CLIs, and is single-user by design |
| `SubZeroDev.AgentKit` `codex/PROFILES.md`, `tools/Measure-Session.ps1` | Codex's sandbox model and on-disk schema — the only Codex evidence that exists here |

## The two things to know before starting

**Codex is unverified.** Its live streaming protocol has never been observed. `20-contract.md`
records a hypothesis drawn from its on-disk rollout schema. S8 begins as an experiment that
reports before any adapter is built — do not treat that table as a specification.

**SSE does not survive Open WebUI's HTTP proxy.** Verified: `text/event-stream` is absent
from its `STREAMING_CONTENT_TYPES`, so responses are buffered. Standalone uses SSE; proxied
deployment needs the WebSocket edge. See `90-decisions.md` D10.

## Running the spike

```bash
cd spike && WORKSPACE_ROOTS=/path/to/a/repo node server.mjs
```

## Running it

The real server ships as a Docker image that installs both the `claude` and `codex` CLIs
but holds no credential of its own for either (`design/00-brief.md`'s "Hosting the model"
non-goal) — every deployment bind-mounts each operator's own already-authenticated CLI
credential directory (typically `~/.claude` and `~/.codex`) in from the host. A vendor an
operator does not use can point its mount at an empty directory; its sessions then fail
per-turn auth, not container startup.

Locally, building from source:

```bash
WORKSPACE_ROOTS_HOST_DIR=/path/to/a/repo \
CLAUDE_CREDENTIALS_DIR=~/.claude \
CODEX_CREDENTIALS_DIR=~/.codex \
AUTH_SECRET=dev-secret \
docker compose -f docker-compose.dev.yml up -d --build
```

The console listens on `http://localhost:3000`.

The repository root's `docker-compose.yml` is the deployment counterpart: it pulls the
image `.github/workflows/publish.yml` publishes to `ghcr.io/the-running-dev/skynet-hr`
rather than building, joins the pre-existing `proxy-net` and publishes no port — see that
file's header for the full set of environment variables a deployment needs to set.

### Running it on Windows

The container above is Linux-only by construction — its `tini`/SIGTERM shutdown path
validates the Linux process model, which `design/00-brief.md`'s Constraints already name as
one of the things that differs between the two platforms Windows is the primary one of.
Running the same image under Docker Desktop's WSL2 layer would exercise Linux's termination
path a second time, not Windows'. So Windows runs the compiled server natively instead, no
container, supervised as a Windows Service via [NSSM](https://nssm.cc) (an operator-installed
tool, the Windows analogue to Docker itself):

```powershell
npm run build
# Write your own deploy.env — KEY=VALUE lines, not committed — with at least AUTH_MODE, its
# per-mode fields, ALLOWED_ORIGINS, WORKSPACE_ROOTS and STORAGE_ROOT (see
# tools/Install-WindowsService.ps1's own comment-based help for the full list; it refuses to
# install with any of them left to a default).
./tools/Install-WindowsService.ps1 -EnvFile C:\skynet-hr\deploy.env -ServiceAccount .\skynet-operator
# then run the sc.exe line it prints to set the service account, and:
nssm start SkyNetHR
```

The service should run as the operator's own Windows account (or a dedicated one whose
profile already holds `.claude`/`.codex`) so the CLIs resolve `%USERPROFILE%\.claude` and
`%USERPROFILE%\.codex` exactly as they would running interactively — no bind mount needed,
because there is no container boundary to cross. The script does not set that account:
doing so non-interactively would put a password on a command line, so it prints the
`sc.exe config` line for you to run instead. For the same reason it writes the environment
block — which holds `AUTH_SECRET` under `shared-secret` — straight to the service's registry
key rather than passing it as an `nssm set` argument.

**Verify the stop path once, before trusting the deployment.** `nssm stop` sends a console
Ctrl event first, which should reach the same `SIGINT` handler `src/server.ts` installs for
local Ctrl+C. That is unproven here: a console-less service may not receive it at all, in
which case NSSM escalates to `TerminateProcess` and children are orphaned while the service
manager still reports a clean stop. The check is one line:

```powershell
nssm stop SkyNetHR
Test-Path "$env:STORAGE_ROOT\server.lock"   # must be False
```

`False` means the stop reached the server's own shutdown path. `True` means it did not —
children were orphaned and the next boot will log a stale-lock reclaim. Report that on
issue #28, which tracks this repository's Windows/Linux parity gap, rather than working
around it.
