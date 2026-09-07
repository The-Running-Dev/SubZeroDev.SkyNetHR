#Requires -Version 7.0
<#
.SYNOPSIS
    Shell-alias invocation for the no-model path of /clean and /next (issue #183).

.DESCRIPTION
    Dot-source this from a PowerShell profile to get two functions that run this repository's
    mechanical housekeeping without starting a model session. This is deliberately a function a
    person types in a terminal they are watching, not a scheduled task: this repository's
    concurrency is sequential-by-policy and not by lock (design/00-brief.md § *Environment*), so
    an unattended run could stash or switch branches under a session that is mid-edit, and a
    stash made unattended has no guaranteed reader. Running it by hand means the report - stash
    ref included - lands in front of whoever ran it, immediately.

    Neither function opens a model session. Where the underlying script reports a judgement
    case, these print it and stop; opening Claude Code, Codex, or Copilot to work it is left to
    the person reading the output (design/00-brief.md's non-goal keeps a human in adjudication,
    and this reading needs no per-vendor launch machinery, unlike having the script launch one
    itself).

.EXAMPLE
    # In $PROFILE:
    . "D:\Dropbox\Projects\SubZeroDev.AgentKit\tools\RepoAliases.ps1"

    # Then, from any of this kit's repositories:
    Invoke-AgentKitClean
    Get-AgentKitNext
#>

$script:RepoAliasesRoot = $PSScriptRoot

function Invoke-AgentKitClean {
    <#
    .SYNOPSIS
        Runs /clean's mechanical half: discover, auto-delete what needs no judgement, report.
    .DESCRIPTION
        Wraps tools/Invoke-Housekeeping.ps1. Prints the report and returns the result object,
        whose .Escalate flags a case this script did not resolve - read it before deciding
        whether to open a session.
    #>
    param([string]$RepoRoot = (Get-Location).Path)
    & (Join-Path $script:RepoAliasesRoot 'Invoke-Housekeeping.ps1') -RepoRoot $RepoRoot
}

function Get-AgentKitNext {
    <#
    .SYNOPSIS
        Runs /next's orientation reads with no model call, for a person to decide the row.
    .DESCRIPTION
        Wraps tools/Get-NextOrientation.ps1 and prints a short human summary before returning
        the full object. Deciding what runs next is unchanged - AGENTS.md § *Session
        boundaries* and next.md's decision table still govern that; this only removes the cost
        of gathering what they are decided against.
    #>
    param([string]$RepoRoot = (Get-Location).Path)
    $orientation = & (Join-Path $script:RepoAliasesRoot 'Get-NextOrientation.ps1') -RepoRoot $RepoRoot

    Write-Host "Branch: $($orientation.CurrentBranch)  Dirty: $($orientation.Dirty)"
    Write-Host "Open PRs: $($orientation.OpenPrs.Items.Count) (gh available: $($orientation.OpenPrs.Available))"
    Write-Host "Recently merged PRs: $($orientation.MergedPrs.Items.Count) (gh available: $($orientation.MergedPrs.Available))"
    Write-Host "design/FROZEN.md present: $($orientation.Frozen)"
    if ($orientation.DesignDrift.Ran) { Write-Host "Test-DesignDrift.ps1 exit code: $($orientation.DesignDrift.ExitCode)" }
    if ($orientation.DesignState.Ran) { Write-Host "Test-DesignState.ps1 exit code: $($orientation.DesignState.ExitCode)" }

    $orientation
}
