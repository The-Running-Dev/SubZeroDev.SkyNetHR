# Agent Console

A browser console for driving a coding agent CLI that runs on the machine holding the code.
Self-hosted, for a small group of trusted operators.

**Status: design + spike.** Nothing here is the implementation. The spike is throwaway
proof that the risky parts are not risky.

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
