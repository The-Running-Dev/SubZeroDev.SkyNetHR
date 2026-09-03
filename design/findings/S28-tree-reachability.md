# S28.1 finding — can a process tree still be reached from the pid of a process that has already exited?

Written before any change to the turn's end path, per S28.1 (`design/30-slices.md § S28`). Measured
on both supported platforms, POSIX (locally on Ubuntu 24.04.4, and confirmed on this repository's
own `windows-latest`/`ubuntu-latest` CI matrix, `.github/workflows/verify.yml`) and Windows Server
2025 (via that same CI matrix — this session has no direct Windows access; see Method).

## Summary

**The two mechanisms diverge, and the divergence is exactly the one the contract already
suspected.** On POSIX, the process group the CLI child roots (D38's `detached: true` at spawn,
`process.kill(-pgid, 'SIGKILL')` at kill time) stays reachable and killable after the group leader
itself has exited, as long as another member of the group is still alive — confirmed directly,
twice, on a real kernel. **On Windows, `taskkill /PID <pid> /T /F` against an already-exited pid
fails outright** (`ERROR: The process "<pid>" not found.`, exit code 128) **and performs no tree
traversal at all** — it never reaches the children, because it never gets past resolving its own
target. This is precisely what `design/30-slices.md § S28` names as the open question: D38's
Windows mechanism "resolves the tree from the live process table at kill time... from a pid that is
by then gone."

A second, independent result compounds the first: **a plain (non-detached) Windows background
child does not reliably survive its own immediate parent's process teardown**, let alone the CLI
child's later exit. In both Windows runs, the grandchild process — spawned successfully
(`child_process.spawn` returned a real pid) — never executed even its own first synchronous
statement (the `started-marker` write, which is the literal first line of its script) before the
immediate parent (`child.mjs`) exited. This means the orphaned-background-process scenario S28
exists to close may not even reach the state D38's kill mechanism was built to handle on Windows: a
plain background job dies on its own, near-instantly, unless it (or its own spawner) explicitly
detaches — and an explicitly-detached process is, by construction, not part of the tree `taskkill
/PID <root-pid> /T` would have walked in the first place, exited root or not.

**S28.2 applies: this slice stops for a decision.** The design's own words already anticipated
this: "Where the kill is issued is `/design`'s and `/contract`'s... This slice may not settle that
by implementing one of them, and a half-platform invariant is not I59." POSIX can implement S28.3
onward as designed; Windows cannot, under the mechanism the contract currently names, once the CLI
child has already exited before the kill is issued.

## Method and runs

`harness/s28-tree-probe.mjs` (temporary, wired into `.github/workflows/verify.yml`'s `test` job for
this measurement only — see the PR history for the commits that added and then removed it; not
part of the shipped tree). It:

1. Spawns `child.mjs` as this script tracks it (`detached: true` on POSIX — the group-leader
   discipline D38 already uses for the CLI child; a plain `spawn` on Windows, since Windows has no
   process-group analogue and D38's own mechanism there is `taskkill /T`, not group membership).
2. `child.mjs` spawns `grandchild.mjs` **not detached** — the same way a shell backgrounds a job
   with `&` without an explicit `setsid`/`CREATE_NEW_PROCESS_GROUP`, which is what a tool call like
   `npm run dev &` produces under the real CLI — then exits immediately, before the grandchild's
   first write is guaranteed to have landed.
3. `grandchild.mjs` writes a `started` marker as its first statement, then a heartbeat file every
   50ms.
4. The probe polls the heartbeat/marker/live-process-image every 50ms for 500ms **after `child.mjs`
   has already exited and before any kill is issued**, to separate "died on its own" from "killed
   by us."
5. It then issues the platform kill against `child.mjs`'s own (already-exited) pid — exactly the
   scenario the contract's normal-completion path will need once S28.3 lands — and polls again.

Two POSIX runs (local, Ubuntu 24.04.4 LTS, Node v22.22.2; CI, `ubuntu-latest` = Ubuntu 24.04.4 LTS,
Node v22.11.0) and two Windows runs (CI, `windows-latest` = Microsoft Windows Server 2025, Node
v22.11.0), the second Windows run refining the probe to poll before any kill after the first run's
result was ambiguous (see below). Commits (this branch): the initial probe, its rewire onto
`verify.yml`'s existing `pull_request` trigger (`workflow_dispatch` cannot be dispatched for a
workflow that does not already exist on the default branch), and the polling refinement.

### POSIX — reachable

```
$ node harness/s28-tree-probe.mjs
platform=linux
command: spawn("/opt/node22/bin/node", [child.mjs], { detached: true }) -> pid 2360
child exited: code=0 signal=null
grandchild pid reported by child (before child exit): 2367
pre-kill samples (grandchild 2367, every 50ms after child exit):
  t+50ms: heartbeat=null started-marker=true live-image="node"
  t+100ms: heartbeat="0" started-marker=true live-image="node"
  ...
  t+500ms: heartbeat="8" started-marker=true live-image="node"
grandchild alive just before kill: true; heartbeat advancing on its own: true
command: process.kill(-2360, 'SIGKILL')
process.kill did not throw
heartbeat immediately after kill: "8"
heartbeat 500ms later: "8"
RESULT: grandchild was alive going into the kill, and was killed by it (tree reachable, kill SUCCEEDED)
```

Identical shape on `ubuntu-latest` CI (pid 2098/2109, `Node v22.11.0`). The grandchild survives its
own spawner's exit (it is reparented, not orphaned to nothing) and stays a member of the group
`child.mjs` led — `process.kill(-pgid, 'SIGKILL')` reaches it even though `pgid` no longer names a
live process of its own. An earlier version of this probe, which detached the grandchild itself
(`detached: true`), got `process.kill` throwing `ESRCH` — a *self-inflicted* negative: `detached:
true` on POSIX calls `setsid()`, putting the grandchild in a **new** session and process group of
its own, unreachable via the original pgid by construction. That is not what a shell's plain `&`
backgrounding does (confirmed by this corrected run), and not a fair test of D38's mechanism, so it
is recorded here only to rule it out as the explanation for the earlier ambiguous Windows result
below.

### Windows — not reachable, and the background job does not survive to be reachable

```
command: spawn("C:\hostedtoolcache\windows\node\22.11.0\x64\node.exe", [child.mjs], { detached: false }) -> pid 8908
child exited: code=0 signal=null
grandchild pid reported by child (before child exit): 9032
pre-kill samples (grandchild 9032, every 50ms after child exit):
  t+50ms: heartbeat=null started-marker=false live-image=null
  ...
  t+500ms: heartbeat=null started-marker=false live-image=null
grandchild alive just before kill: false; heartbeat advancing on its own: false
command: taskkill /PID 8908 /T /F
ERROR: The process "8908" not found.
taskkill exit code: 128
heartbeat immediately after kill: null
heartbeat 500ms later: null
RESULT: grandchild was already gone before any kill was issued (died on its own once child.mjs exited) -- INCONCLUSIVE for reachability, see pre-kill samples
```

`started-marker=false` at every sample means the grandchild never executed even its own first
synchronous line — `child_process.spawn` returned a real pid (9032), so `CreateProcess` succeeded,
but the process was gone (or never scheduled) before it could run anything. This was consistent
across both Windows CI runs (first run: pid 7372/5884, `heartbeat before kill: null`, same
`taskkill... not found` / exit 128 result; second run, above, with the finer-grained polling that
rules out a race in the observation itself rather than the process).

`taskkill /PID 8908 /T /F` fails with `ERROR: The process "8908" not found.` (exit code 128)
**regardless of whether the grandchild would have survived** — `taskkill` resolves its `/PID`
target first and refuses to proceed to `/T`'s tree walk at all once that lookup fails, exactly as
`design/30-slices.md § S28` names as the open question. This was true on both runs, independent of
the grandchild's own fate.

## Why the grandchild died before running: not this session's to resolve, but recorded

The most likely explanation, consistent with Node's own documented Windows behavior (`detached:
true` on Windows is what decouples a child from its parent's console via
`CREATE_NEW_PROCESS_GROUP`), is that a plain, non-detached Windows child stays attached to the
console/process group its spawner controls, and is torn down at or near the moment that spawner's
own process object is destroyed — well before the CLI's later, unrelated exit that this slice's
kill is meant to guard against. Confirming the exact OS mechanism (console control dispatch vs.
some GitHub Actions runner-specific job-object behavior) is outside what S28.1 asks for and is not
attempted here; the operative fact for this slice is that neither of the two Windows runs found a
surviving grandchild to reach, with or without an explicit kill.

## Answer to S28.1, and consequence for S28.2

**Yes on POSIX, no on Windows**, and the "no" has two independent causes: `taskkill /PID <exited
pid> /T /F` cannot walk a tree it never resolves a root for, and (at least for a plainly
backgrounded, non-detached child) there may be nothing left alive to walk to by the time any kill —
early or late — could run.

Per S28.2, this slice stops here. Whether the kill moves earlier (into the `result` record, before
the child is allowed to exit — which the contract's current wording forbids: "before `turn.ended`
is emitted and before the turn slot is cleared", not before the child exits) is `/design`'s and
`/contract`'s decision, not this slice's, and a half-platform invariant is not I59.
