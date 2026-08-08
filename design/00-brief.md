# Brief — SkyNet HR

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

Two tiers. Tier one is the console, and it is finishable on its own — nothing in tier two
blocks it. Tier two is the surfaces admitted in `90-decisions.md` D53 to D55 and D58. Tier
two is binding scope, not a wish list; it is later, not optional.

### Tier one — the console

An operator can, from a browser:

1. Authenticate, and see only their own sessions.
2. Start a session against a workspace directory, choosing Claude or Codex.
3. Send a message and watch the agent's output stream in, including tool calls.
4. Approve or deny a Claude tool-permission request, and have the agent continue.
5. Refresh the page mid-turn and lose nothing.
6. Roll the workspace back to its state before any earlier message.
7. Read an audit record of every tool approval: who, what, when.

Item 4 names Claude by decision, not by omission. A Codex session satisfies items 3 and 5
to 7, and in place of per-call approval runs under a launch-time policy with a persistent
banner naming its sandbox — see D5 and D27. Whether Codex's runtime approval is reachable
over a programmatic transport is unverified, and tier one does not wait on that answer.

Tier one is not done until both supported platforms are proven by an automated run rather
than by assertion. See Constraints.

### Tier two — the operator's working surfaces

8. See what a session has cost: token burn to date, budget remaining, and paid idle time.
9. Record a performance review against a session, with an author and a draft state, and see
   whether a session is under a performance plan.
10. Open a session through a requisition someone approved, and work a first-run checklist
    for it.
11. Read the audit record as a history of incidents, not only as a flat log.
12. Choose which of the four visual systems the console presents.

## Non-goals

Binding. Out of scope even where a change looks trivial.

- **Untrusted users.** Console access is equivalent to shell access as the server's user.
  Defending operators from each other needs container-per-session isolation and is a
  different project. See `10-design.md § Threat model`.
- **Hosting the model.** We drive an agent CLI that is already installed and already
  authenticated. No inference happens here and no vendor credential is held. This does not
  make reported usage invisible: token counts arrive in the CLI's own stream, which the
  console already parses, and a budget is a value the operator sets in configuration.
- **Replacing the agent's own context management.** The CLI owns conversation state and
  compaction. We render and replay; we do not reconstruct.
- **An editor.** No file tree, no code editing, no diff authoring. Diffs are rendered
  read-only because the agent emits them.
- **Mobile-first design.** It must not break on a phone, since approving a tool call from
  one is a real use, but layout effort goes to desktop.
- **Multi-agent orchestration.** A session drives one agent on one operator's behalf. An
  agent may not start another agent, and work may not move between sessions without an
  operator action: a session started by a child process has no caller identity, so tier-one
  item 7 would have nobody to record. What this does *not* forbid — an operator assigning
  work to a session is an operator action and is in scope, and concurrent sessions always
  were. See D52.

## Constraints

- Node/TypeScript on the server. This is the stack the operators already maintain.
- No inbound internet exposure assumed. Deployment sits behind either a reverse proxy that
  authenticates, or a LAN boundary.
- Must run on Windows and Linux servers. The primary host is Windows. Both are supported
  targets held to the same definition of done, and both are gated by an automated run — path
  handling, process termination and workspace rollback all differ between them. No such gate
  exists yet; building it is tier-one work.

## What we are copying, and from where

`Forks-Claude-Code-Chat` (a VS Code extension, licence: all rights reserved, **reference
only — no code may be copied**) established the working technique for driving the Claude
CLI. What we take from it is knowledge of a documented protocol, not source. The specific
findings and their provenance are recorded in `10-design.md § Prior art`.
