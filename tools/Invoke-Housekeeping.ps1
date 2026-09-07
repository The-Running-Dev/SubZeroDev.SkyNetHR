#Requires -Version 7.0
<#
.SYNOPSIS
    The no-model invocation path for /clean's mechanical half: discover, auto-delete
    what needs no judgement, and say plainly when something does.

.DESCRIPTION
    clean.md's "Merged" and "SafeDelete" gates, and the squash-merge tip-equals-merged-head
    comparison, are all facts Invoke-DoneHousekeeping.ps1 already computes - nothing about
    applying them requires a model in the loop. This script is the missing invocation: it
    calls Invoke-DoneHousekeeping.ps1 once to discover candidates, then again to delete every
    branch that discovery run confirmed, and reports the result the way clean.md's own
    "Report" section requires - stash, pruned count, deletions, and anything left over.

    It never calls a model and it never launches one. Where the underlying script surfaces a
    genuine judgement call - Stopped:true, a TipAheadOfMergedPr entry, or a branch that failed
    -DeleteBranches/-ForceDeleteBranches for a reason other than "not a confirmed candidate" -
    this script stops applying deletes and returns Escalate:true with those cases named. A
    human reads that and decides whether to open a session; this script does not open one
    itself (issue #183's own environment note: the two vendors besides Claude Code have no
    invocation machinery here, and design/00-brief.md's non-goal keeps a human in adjudication
    either way).

    Intended to run from an interactive shell - see tools/RepoAliases.ps1 for the function that
    wraps this for a PowerShell profile. A stash made by -AutoStash is printed directly to the
    console so whoever is watching the terminal sees it; there is no unattended path here that
    could let it go unreported, by design (design/90-decisions.md's 2026-09-06 entry on #183
    records why a scheduled task was rejected: this repository's concurrency is
    sequential-by-policy and not by lock, so an unattended run could stash or switch branches
    out from under a session that is mid-edit).

.PARAMETER RepoRoot
    Repository to operate on. Defaults to the current directory.

.PARAMETER DefaultBranch
    Override the default branch instead of resolving it from `git remote show origin`.

.PARAMETER SkipPull
    Passed through to the discovery call. For no network access to the remote, or for testing
    against a local-only fixture.

.EXAMPLE
    ./tools/Invoke-Housekeeping.ps1
    Switch to the default branch, delete every branch that needs no judgement, and report.

.EXAMPLE
    ./tools/Invoke-Housekeeping.ps1 -RepoRoot D:\Dropbox\Projects\SubZeroDev.AgentKit
#>
[CmdletBinding()]
param(
    [string] $RepoRoot = (Get-Location).Path,
    [string] $DefaultBranch,
    [switch] $SkipPull
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$doneScript = Join-Path $PSScriptRoot 'Invoke-DoneHousekeeping.ps1'

$discoverArgs = @{
    RepoRoot  = $RepoRoot
    SkipPull  = $SkipPull
    AutoStash = $true
}
if ($DefaultBranch) { $discoverArgs.DefaultBranch = $DefaultBranch }

$discover = & $doneScript @discoverArgs

if ($discover.Stashed) {
    Write-Host "Stashed uncommitted changes as $($discover.StashRef) - restore with: git stash apply $($discover.StashRef)"
}

if ($discover.Stopped) {
    Write-Warning "Stopped: $($discover.Reason) - $($discover.Detail)"
    return [pscustomobject]@{
        Escalate  = $true
        Discover  = $discover
        Applied   = $null
    }
}

$candidateNames = @($discover.Candidates | ForEach-Object Branch)
$squashNames    = @($discover.SquashMergeCandidates | ForEach-Object Branch)

$applied = if ($candidateNames.Count -or $squashNames.Count) {
    & $doneScript -RepoRoot $RepoRoot -DefaultBranch $discover.DefaultBranch -SkipPull `
        -DeleteBranches $candidateNames -ForceDeleteBranches $squashNames
}
else {
    $discover
}

Write-Host "Default branch: $($applied.DefaultBranch)  (pulled: $($applied.Pulled))"
Write-Host "Pruned remote-tracking refs: $($applied.PrunedCount)"
if ($applied.Deleted.Count) {
    Write-Host "Deleted:"
    foreach ($branch in $applied.Deleted) { Write-Host "  - $branch" }
}
else {
    Write-Host "Deleted: (none)"
}

$escalate = $false

if (@($discover.TipAheadOfMergedPr).Count) {
    $escalate = $true
    Write-Warning "TipAheadOfMergedPr - commits exist that no merged PR accounts for:"
    foreach ($entry in $discover.TipAheadOfMergedPr) {
        Write-Warning "  $($entry.Branch): $($entry.Reason)"
    }
}

if (@($applied.Refused).Count) {
    $escalate = $true
    Write-Warning "Refused:"
    foreach ($entry in $applied.Refused) {
        Write-Warning "  $($entry.Branch): $($entry.Reason)"
    }
}

if ($escalate) {
    Write-Warning "A judgement case was found. This script has not decided anything about it - read the cases above and open a session if one is warranted."
}

[pscustomobject]@{
    Escalate = $escalate
    Discover = $discover
    Applied  = $applied
}
