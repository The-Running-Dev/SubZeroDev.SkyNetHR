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

Windows runs the same Linux container, under [Docker Desktop](https://docs.docker.com/desktop/).
There is no second delivery mechanism and no native Windows build to deploy — the compose files
above are the whole story on both platforms. **Windows Server is not a target**, because Docker
Desktop does not run there; `design/00-brief.md`'s Constraints state that, and
`design/90-decisions.md` D244 records why the earlier native-service path was withdrawn.

Paths on either side of a bind mount are the only real difference. Give Docker Desktop Windows
paths and let it translate:

```powershell
$env:WORKSPACE_ROOTS_HOST_DIR = 'C:\src\a-repo'
$env:CLAUDE_CREDENTIALS_DIR   = "$env:USERPROFILE\.claude"
$env:CODEX_CREDENTIALS_DIR    = "$env:USERPROFILE\.codex"
$env:AUTH_SECRET              = 'dev-secret'
docker compose -f docker-compose.dev.yml up -d --build
```

`WORKSPACE_ROOTS` inside the container stays `/workspaces` — it names container paths, not host
ones, and the jail resolves real paths on the container's side of the mount.

**The credential mounts have been observed working from a Windows host** — see
[#389](https://github.com/The-Running-Dev/SubZeroDev.SkyNetHR/issues/389) for what was checked.
Mount ownership is not a Windows concern: Docker Desktop's bind-mount translation layer presents
`CLAUDE_CREDENTIALS_DIR`/`CODEX_CREDENTIALS_DIR` as `root:root` mode `777` regardless of the
Windows-side owner, and the container's uid-1000 `node` user can read and write them freely — no
`chown` step, unlike the Linux-host case `docker-compose.dev.yml`'s header still describes. A
`claude` turn runs to completion unmodified. A `codex` turn needs one more thing than the
mount itself: the CLIs inside the container are Linux builds, and a `.codex` directory carrying
state written by a *different* Linux- or Windows-built `codex` can include a session-state
SQLite file (`state_5.sqlite`) at a schema migration the container's pinned build won't open —
it fails fast with `failed to initialize in-process app-server client: Operation not permitted`
before it ever reaches the network. `auth.json` and `config.toml` are unaffected; if a turn
fails this way, delete or move aside the `state_*.sqlite` files in the mounted `.codex`
directory and retry.

### One-command setup (Windows, PowerShell 7)

`tools/Start-SkyNetHR.ps1` wraps the manual steps above for a local dev run: it resolves
`WORKSPACE_ROOTS_HOST_DIR`, `CLAUDE_CREDENTIALS_DIR` and `CODEX_CREDENTIALS_DIR` (defaulting
to `~/.claude`/`~/.codex`), generates and persists `AUTH_SECRET` in a git-ignored `.env` so
restarts keep the same login, warns about the `state_*.sqlite` hazard above without touching
the files itself, then runs `docker compose -f docker-compose.dev.yml up -d --build` and polls
`/readyz` until the console is actually serving.

```powershell
./tools/Start-SkyNetHR.ps1
```

On success it prints the console URL and the secret to paste into the login box. Rerun with
`-Recreate` to force-recreate the container, `-Logs` to tail it, `-Stop`/`-Down` to stop the
stack. See `Get-Help ./tools/Start-SkyNetHR.ps1 -Full` for every parameter.
