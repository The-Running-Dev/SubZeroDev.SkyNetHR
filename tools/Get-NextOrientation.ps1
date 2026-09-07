#Requires -Version 7.0
<#
.SYNOPSIS
    The no-model invocation path for /next's orientation reads.

.DESCRIPTION
    next.md's "Orient" section runs six read-only commands before any decision is made:
    git status, the current branch, open and merged pull requests, and the two design gate
    scripts. None of that is a judgement call - next.md says so explicitly ("What this command
    adds is a check of what is outstanding, which orientation alone does not answer"). This
    script runs exactly those six reads and returns them as one object, so a person (or a
    model session opened afterward) can pick the row in AGENTS.md § *Session boundaries* /
    next.md's decision table without a model having spent anything gathering the inputs to it.

    This script decides nothing. It does not pick a row, and it does not open a session.
    Reading its output and choosing what runs next stays exactly the judgement call next.md
    already says it is.

.PARAMETER RepoRoot
    Repository to read. Defaults to the current directory.

.EXAMPLE
    ./tools/Get-NextOrientation.ps1
#>
[CmdletBinding()]
param(
    [string] $RepoRoot = (Get-Location).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $RepoRoot)) {
    throw "RepoRoot '$RepoRoot' does not exist."
}
$repoRootResolved = (Resolve-Path -LiteralPath $RepoRoot).Path

function Invoke-Gh {
    param([string[]]$GhArgs, [string]$WorkingDir)
    Push-Location $WorkingDir
    try {
        $out = & gh @GhArgs 2>$null
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $out }
    }
    finally { Pop-Location }
}

function Invoke-GateScript {
    # Test-DesignDrift.ps1 and Test-DesignState.ps1 both `exit` with a code, so they are read
    # as external processes rather than dot-sourced - the same reason Measure-Session.Tests.ps1
    # and this repository's other tools scripts invoke each other with `&`, never `.`.
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ Ran = $false; ExitCode = $null; Output = $null }
    }
    $output = & $Path *>&1 | Out-String
    return [pscustomobject]@{ Ran = $true; ExitCode = $LASTEXITCODE; Output = $output.TrimEnd() }
}

$status = & git -C $repoRootResolved status --short --branch
$currentBranch = (& git -C $repoRootResolved branch --show-current).Trim()

$openPr = Invoke-Gh -GhArgs @('pr', 'list', '--state', 'open', '--json', 'number,title,headRefName') -WorkingDir $repoRootResolved
$mergedPr = Invoke-Gh -GhArgs @('pr', 'list', '--state', 'merged', '--limit', '5', '--json', 'number,title,mergedAt') -WorkingDir $repoRootResolved

$frozenPath = Join-Path $repoRootResolved 'design/FROZEN.md'
$frozen = Test-Path -LiteralPath $frozenPath
$frozenContent = if ($frozen) { Get-Content -LiteralPath $frozenPath -Raw } else { $null }

$drift = Invoke-GateScript -Path (Join-Path $repoRootResolved 'tools/Test-DesignDrift.ps1')
$state = Invoke-GateScript -Path (Join-Path $repoRootResolved 'tools/Test-DesignState.ps1')

[pscustomobject]@{
    RepoRoot      = $repoRootResolved
    Dirty         = [bool]($status | Where-Object { $_ -and $_ -notmatch '^##' })
    Status        = @($status)
    CurrentBranch = $currentBranch
    OpenPrs       = [pscustomobject]@{ Available = ($openPr.ExitCode -eq 0); Items = if ($openPr.ExitCode -eq 0 -and $openPr.Output) { $openPr.Output | ConvertFrom-Json } else { @() } }
    MergedPrs     = [pscustomobject]@{ Available = ($mergedPr.ExitCode -eq 0); Items = if ($mergedPr.ExitCode -eq 0 -and $mergedPr.Output) { $mergedPr.Output | ConvertFrom-Json } else { @() } }
    Frozen        = $frozen
    FrozenContent = $frozenContent
    DesignDrift   = $drift
    DesignState   = $state
}
