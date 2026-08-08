# Brief — Agent Console

## Problem

Driving a coding agent means a terminal on the machine that holds the code. That is fine
for one person at one desk and awkward everywhere else: no shared view of what an agent
did, no way to approve a tool call from a phone, no record of who let the agent run what.

We want a browser console that fronts an already-installed agent CLI — the operator opens
a page, picks a workspace, talks to the agent, and approves or denies its tool calls, with
the agent process itself running on the server next to the code.

## Who this is for

A small group of trusted operators — the people who would otherwise have SSH on the box.
Self-hosted on a LAN machine or a private VPS. Not a public service, not a product.

## Definition of done

An operator can, from a browser:

1. Authenticate, and see only their own sessions.
2. Start a session against a workspace directory, choosing Claude or Codex.
3. Send a message and watch the agent's output stream in, including tool calls.
4. Approve or deny a Claude tool-permission request, and have the agent continue.
5. Refresh the page mid-turn and lose nothing.
6. Roll the workspace back to its state before any earlier message.
7. Read an audit record of every tool approval: who, what, when.

## Non-goals

Binding. Out of scope even where a change looks trivial.

- **Untrusted users.** Console access is equivalent to shell access as the server's user.
  Defending operators from each other needs container-per-session isolation and is a
  different project. See `10-design.md § Threat model`.
- **Hosting the model.** We drive an agent CLI that is already installed and already
  authenticated. No API keys are held by this server, no inference happens here.
- **Replacing the agent's own context management.** The CLI owns conversation state and
  compaction. We render and replay; we do not reconstruct.
- **An editor.** No file tree, no code editing, no diff authoring. Diffs are rendered
  read-only because the agent emits them.
- **Mobile-first design.** It must not break on a phone, since approving a tool call from
  one is a real use, but layout effort goes to desktop.
- **Multi-agent orchestration.** One session, one agent process. Fan-out is not in scope.

## Constraints

- Node/TypeScript on the server. This is the stack the operators already maintain.
- No inbound internet exposure assumed. Deployment sits behind either a reverse proxy that
  authenticates, or a LAN boundary.
- Must run on Windows and Linux servers. The primary host is Windows; CI is Linux.

## What we are copying, and from where

`Forks-Claude-Code-Chat` (a VS Code extension, licence: all rights reserved, **reference
only — no code may be copied**) established the working technique for driving the Claude
CLI. What we take from it is knowledge of a documented protocol, not source. The specific
findings and their provenance are recorded in `10-design.md § Prior art`.
