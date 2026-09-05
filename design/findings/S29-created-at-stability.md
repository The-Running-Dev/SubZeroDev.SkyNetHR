# S29.1 finding — is a live process's OS-reported creation time readable, and stable across two reads?

Written before any change to `ProcessRecord`, per S29.1 (`design/30-slices.md § S29`). Measured on
both supported platforms via this repository's own `verify.yml` matrix (`ubuntu-latest`,
`windows-latest`), plus three additional local runs on this session's own Linux sandbox.

## Summary

**Both platforms produce a value, and it is stable: two reads of the same live process's creation
time are byte-identical, every run.** The fourth limb I19 requires — exact equality against a
recorded `osCreatedAt` — is buildable on both supported platforms. `osCreatedAt` is capturable at
spawn and comparable later without a tolerance window.

## Method and runs

`harness/s29-created-at-probe.mjs` (temporary; wired into `.github/workflows/verify.yml`'s `test`
job for this measurement only, then removed in the same PR once both readings were captured — see
this PR's earlier commit for the wiring and this one for its removal). It:

1. Spawns a child process that stays alive for 5 seconds (`sleep 5` on POSIX,
   `Start-Sleep -Seconds 5` on Windows) and waits 300ms for it to be scheduled.
2. Reads the platform's own creation-time value for that live pid, waits 250ms, and reads it again.
3. Reports both readings and whether they are byte-identical, as JSON to stdout.

**Linux**: `/proc/[pid]/stat` field 22 (`starttime`, in clock ticks since boot, per `man proc`),
added to `/proc/stat`'s `btime` line (the kernel's own boot time, seconds since the epoch) after
dividing by `getconf CLK_TCK`. Both source files are read fresh on each of the two calls; the
result is formatted as an ISO timestamp.

**Windows**: `(Get-Process -Id <pid>).StartTime.ToUniversalTime().ToString('o')`, invoked as a
fresh `powershell` process on each of the two calls — not read once and printed twice — so a
result that only looks stable because it was cached is ruled out.

| Run | Platform | OS | Node | First read | Second read | Identical |
|---|---|---|---|---|---|---|
| CI, `ubuntu-latest` | Linux | Ubuntu 24.04.4 LTS, kernel 6.17.0-1022-azure | v22.11.0 | `2026-09-05T05:41:23.960Z` | `2026-09-05T05:41:23.960Z` | yes |
| CI, `windows-latest` | Windows | Microsoft Windows Server 2025, 10.0.26100 | v22.11.0 | `2026-09-05T05:41:32.7848697Z` | `2026-09-05T05:41:32.7848697Z` | yes |
| Local (this session's sandbox) | Linux | `6.18.44-fc-v24` | v22.22.2 | `2026-09-05T05:40:20.360Z` | `2026-09-05T05:40:20.360Z` | yes |
| Local (this session's sandbox) | Linux | `6.18.44-fc-v24` | v22.22.2 | `2026-09-05T05:40:25.710Z` | `2026-09-05T05:40:25.710Z` | yes |
| Local (this session's sandbox) | Linux | `6.18.44-fc-v24` | v22.22.2 | `2026-09-05T05:40:26.330Z` | `2026-09-05T05:40:26.330Z` | yes |

Five runs, five identical pairs, zero mismatches, across three distinct kernels and both supported
platforms.

## Consequence for S29

S29.1's stop condition — "the slice stops where either platform cannot produce a stable exact
value" — does not fire. Both limbs are buildable: `ProcessRecord.osCreatedAt` is captured with the
Linux and Windows readers above at spawn, compared with exact string equality at reap time (I19),
and is `null` only when the read itself fails (S29.7) or the platform is neither of the two
measured here.
