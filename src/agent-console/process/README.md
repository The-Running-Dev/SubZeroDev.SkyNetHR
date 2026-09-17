# ProcessSupervisor — Phase 3

Internal extraction of the existing SkyNetHR process mechanism. `index.ts` composes
process metadata, tree termination and an injected `ProcessLedger`; providers use its
shared spawn, environment, stdin and termination primitives. A spawned child exposes
Node's streams and lifecycle callbacks directly, preserving callback order. Providers
retain protocol mapping, child ownership and all three superseded-child close guards.

| Mechanism | Location | Preserved behavior |
| --- | --- | --- |
| Resolution/spawn/streams/stdin | `spawn.ts` | Windows shell shims and shell image, Node fixtures, cwd, detached POSIX groups, pipe errors and EOF |
| Environment | `environment.ts` | Default host inheritance plus existing overrides; explicit constructed mode retains essentials, proxy/TLS, declared provider names and host entries |
| Live-child termination | `termination.ts` | Windows dispatches `taskkill /PID <pid> /T /F`; POSIX sends group TERM with child fallback, then an unref'ed 2000 ms group KILL/child fallback only while still owned |
| Orphan/muted-spawn termination | `termination.ts` | Windows awaits taskkill and preserves warnings; POSIX immediately sends group KILL, swallowing failure without a pid fallback |
| Probe timeout | `termination.ts` | Immediate force-kill, Windows ignored stdio, POSIX group KILL with child fallback |
| OS identity | `metadata.ts` | tasklist/Get-Process, Linux comm/stat/CLK_TCK, macOS image lookup and unknown creation time; existing image comparison |
| PID ledger | `ledger.ts`, `fs-ledger.ts` | Injected interface; unchanged `pids.ndjson` lines, lazy append handle, tombstone and latest-line-per-pid fold |

`append-log.ts` holds the existing low-level append/fold helpers shared with the host
store. Moving those helpers avoids duplicating their handle and error behavior. The
host store still owns audit, reviews, requisitions, session storage and resource closing.
The manager still supplies process facts and decides whether and when to reap, kill or
write a tombstone. It retains the hostname/image/boot/creation-time guards and all event,
permission, audit and shutdown sequencing. No Phase 3b work is included.

Integration baseline: Phase 2 #357 and fixes #358, #359, #363 and #364 were present on
`main`; #365 corrected the contract's description of staged POSIX termination before
this extraction. D235 identifies the original #359 ordering decision; the Phase 2
decision and its references are reconciled as D236. No decision meaning changes.

Verification: the existing provider, S7, S27, S28 and S29 tests retain their assertions.
The new tests cover spawn/exit/streams/EOF, command resolution, both termination
branches and ownership, live metadata, environment filtering and compatibility,
ledger bytes/reopening/failed-open retry, and manager use of an injected ledger.
The repository Windows/Linux CI matrix exercises the real platform paths.
