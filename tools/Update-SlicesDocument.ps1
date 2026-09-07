#Requires -Version 7.0
<#
.SYNOPSIS
    Retires a landed slice's full body out of design/30-slices.md § Outstanding, into a row
    under § Landed (issue #120).

.DESCRIPTION
    `design/30-slices.md`, "How this document is kept", says a slice's full body lives under
    `## Outstanding` only until its issue closes, at which point the body is retired to the
    `## Landed` index and the name, issue number, criteria range, and the commit the body was
    last complete at are all that remain. Nothing performed that move - #120 found fifteen
    slices sitting under `## Outstanding` with closed issues, because both `/track` (which
    cannot write to this document's body) and `/reconcile` (barred from this document outright)
    stopped short of it. This script is that missing mechanism.

    For every `### S<n> - <name>` section under `## Outstanding`:
      1. Look up a tracker issue whose title begins `S<n> ` (Test-DesignDrift.ps1's own match),
         open or closed.
      2. A slice with no issue, or an open one, is left exactly as found - not a finding, since
         `/track` is what opens a missing issue and closing early is not this script's call.
      3. A slice with a closed issue is retired: its full section is removed from
         `## Outstanding`, and a row naming its number, name, the issue (closed), the min-max
         range of every `S<n>.<m>` id in its `Acceptance:` block, and the short SHA of the last
         commit that touched this file, is appended to the `## Landed` table.

    Mechanical only, on purpose (AGENTS.md, "What should stop being model work" - moving text
    and reading an id range is set arithmetic over one file). It never touches the document's
    hand-authored prose - the overview blockquote, the per-slice narrative preamble, or the
    "What each delivered" list - because none of that is derivable from the tracker; a session
    running this script still has to read what is left and correct any of that prose the
    retirement made stale, by hand, in the same commit (AGENTS.md, "Descriptive drift is
    corrected where it is found").

    Never opens, closes, or edits an issue - read-only against the tracker, exactly as
    Test-DesignDrift.ps1 is (I13).

.PARAMETER SlicesPath
    Path to the slices document. Defaults to design/30-slices.md beside this script's repo root.

.PARAMETER Repository
    owner/repo. Defaults to the current git remote, via gh's own resolution.

.PARAMETER DryRun
    Reports what would be retired without writing the file.

.EXAMPLE
    pwsh ./tools/Update-SlicesDocument.ps1
#>
[CmdletBinding()]
param(
    [string] $SlicesPath,
    [string] $Repository,
    [switch] $DryRun,
    [switch] $Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Test-DesignDrift.ps1 and Update-WorkMirror.ps1 both assign this for the same reason: a
# gh/git exit code read as an answer, not an error, would otherwise become a terminating
# exception under Stop on PowerShell 7.3+. Inert on versions that predate the preference.
$PSNativeCommandUseErrorActionPreference = $false

function New-RetireFailure {
    param([Parameter(Mandatory)][string] $Reason, [Parameter(Mandatory)][string] $Detail)
    [pscustomobject]@{ Reason = $Reason; Detail = $Detail }
}


<#
    PowerShell's `..` range operator counts *down* when its start exceeds its end rather than
    yielding an empty sequence, so `$array[($i+1)..($array.Count-1)]` silently wraps and reads
    one element past the array's end whenever $i is the array's last index. Every "the rest of
    the array from here" slice in this script goes through this instead of the bare range.
#>
function Get-ArraySlice {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Array, [Parameter(Mandatory)][int] $From)
    if ($From -gt $Array.Count - 1) { return @() }
    @($Array[$From..($Array.Count - 1)])
}

function New-RetireResult {
    param(
        [Parameter(Mandatory)][string] $State,
        [object[]] $Retired = @(),
        [object[]] $Left = @(),
        [object[]] $CouldNotEvaluate = @()
    )
    [pscustomobject]@{
        State            = $State
        Retired          = @($Retired)
        Left             = @($Left)
        CouldNotEvaluate = @($CouldNotEvaluate)
    }
}

function Invoke-GhRaw {
    <#
        Same UTF-8-via-ProcessStartInfo shape as Test-DesignDrift.ps1 and Update-WorkMirror.ps1
        - PowerShell's native-command capture decodes gh's UTF-8 stdout using the console's own
        encoding, which is the OEM code page on a Windows host, corrupting a non-ASCII byte in
        an issue title (an em dash) before it ever reaches the regex below.
    #>
    param([string[]] $GhArgs)
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'gh'
    foreach ($a in $GhArgs) { $psi.ArgumentList.Add($a) }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.ReadToEnd()
    $proc.StandardError.ReadToEnd() | Out-Null
    $proc.WaitForExit()
    [pscustomobject]@{ Output = $stdout; ExitCode = $proc.ExitCode }
}

function Get-TrackerIssue {
    param([string] $Repository)

    $ghArgs = @('issue', 'list', '--state', 'all', '--limit', '200', '--json', 'number,title,state,body')
    if ($Repository) { $ghArgs += @('-R', $Repository) }

    try {
        $result = Invoke-GhRaw -GhArgs $ghArgs
        if ($result.ExitCode -ne 0) {
            return [pscustomobject]@{ Issues = @(); Failure = (New-RetireFailure -Reason 'GhUnavailable' -Detail "gh exited $($result.ExitCode)") }
        }
        $json = $result.Output
    } catch {
        return [pscustomobject]@{ Issues = @(); Failure = (New-RetireFailure -Reason 'GhUnavailable' -Detail $_.Exception.Message) }
    }

    if ([string]::IsNullOrWhiteSpace($json)) {
        return [pscustomobject]@{ Issues = @(); Failure = (New-RetireFailure -Reason 'GhUnavailable' -Detail 'gh returned no output') }
    }

    try {
        $parsed = $json | ConvertFrom-Json
    } catch {
        return [pscustomobject]@{ Issues = @(); Failure = (New-RetireFailure -Reason 'TrackerUnreadable' -Detail $_.Exception.Message) }
    }

    [pscustomobject]@{ Issues = @($parsed); Failure = $null }
}

<#
    Splits the document into: everything before `## Outstanding`, the Outstanding section's own
    slice blocks (each starting at a `### S<n> - <name>` heading and running to the line before
    the next `##`/`###` heading), and everything from `## Landed` on. A slice block that is not
    immediately preceded by `## Outstanding` at some point above it, or one nested any deeper
    than `###`, is not a slice this script recognises - the same depth Test-DesignDrift.ps1
    matches (`^#{2,3}\s+S(?<n>\d+)`), since S1-S18 sat at `##` and S19 on sit at `###` nested
    under `## Outstanding` (design/90-decisions.md, 2026-08-30).
#>
function Get-SliceDocumentModel {
    param([Parameter(Mandatory)][string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ Failure = (New-RetireFailure -Reason 'SlicesDocMissing' -Detail $Path) }
    }

    $lines = @(Get-Content -LiteralPath $Path)

    $outstandingStart = -1
    $landedStart = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($outstandingStart -lt 0 -and $lines[$i] -match '^##\s+Outstanding\s*$') { $outstandingStart = $i }
        if ($landedStart -lt 0 -and $lines[$i] -match '^##\s+Landed\s*$') { $landedStart = $i }
    }

    if ($outstandingStart -lt 0) {
        return [pscustomobject]@{ Failure = (New-RetireFailure -Reason 'NoOutstandingSection' -Detail $Path) }
    }
    if ($landedStart -lt 0 -or $landedStart -le $outstandingStart) {
        return [pscustomobject]@{ Failure = (New-RetireFailure -Reason 'NoLandedSection' -Detail $Path) }
    }

    # Every `##`/`###` heading strictly between the two section markers - not just the ones
    # naming a slice - because a slice's body ends at the *next heading of any kind*, and
    # `## Outstanding` carries evergreen non-slice notes ("A note on counts", "Interim findings
    # are expected") after the last slice. Bounding every slice's end at $landedStart - 1
    # regardless of what comes after it would fold those notes into the last slice's body and
    # delete them the moment that slice is retired - caught by re-running this script against
    # this repository's own document before it ever reached a commit.
    $allHeadingIdx = [System.Collections.Generic.List[int]]::new()
    $sliceHeadingIdx = [System.Collections.Generic.List[int]]::new()
    for ($i = $outstandingStart + 1; $i -lt $landedStart; $i++) {
        if ($lines[$i] -match '^#{2,3}\s') {
            $allHeadingIdx.Add($i)
            if ($lines[$i] -match '^###\s+S(?<n>\d+)\s+—\s+(?<name>.+?)\s*$') {
                $sliceHeadingIdx.Add($i)
            }
        }
    }

    $slices = [System.Collections.Generic.List[object]]::new()
    foreach ($start in $sliceHeadingIdx) {
        $nextHeading = $allHeadingIdx | Where-Object { $_ -gt $start } | Select-Object -First 1
        $end = if ($nextHeading) { $nextHeading - 1 } else { $landedStart - 1 }
        # Trim trailing blank lines from the body so removing it leaves a single blank line,
        # not a run of them, before whatever follows.
        while ($end -gt $start -and [string]::IsNullOrWhiteSpace($lines[$end])) { $end-- }

        $lines[$start] -match '^###\s+S(?<n>\d+)\s+—\s+(?<name>.+?)\s*$' | Out-Null
        $number = [int]$Matches['n']
        $name   = $Matches['name']

        $ids = [System.Collections.Generic.List[int]]::new()
        for ($k = $start; $k -le $end; $k++) {
            if ($lines[$k] -match "^\s*-\s+S$number\.(?<m>\d+)\b") {
                $ids.Add([int]$Matches['m'])
            }
        }

        $slices.Add([pscustomobject]@{
            Number    = $number
            Name      = $name
            StartLine = $start
            EndLine   = $end
            Criteria  = @($ids | Sort-Object -Unique)
        })
    }

    [pscustomobject]@{
        Lines             = $lines
        OutstandingStart  = $outstandingStart
        LandedStart       = $landedStart
        Slices            = @($slices)
        Failure           = $null
    }
}

function Get-BodyCompleteAtSha {
    param([Parameter(Mandatory)][string] $Path)

    try {
        $dir = Split-Path -Parent (Resolve-Path -LiteralPath $Path).Path
        Push-Location $dir
        $sha = (& git log -1 --format=%h -- (Resolve-Path -LiteralPath $Path).Path 2>$null)
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sha)) { return $null }
        return $sha.Trim()
    } catch {
        return $null
    } finally {
        Pop-Location
    }
}

function Format-CriteriaRange {
    param([Parameter(Mandatory)][int] $Number, [Parameter(Mandatory)][AllowEmptyCollection()][int[]] $Criteria)
    if ($Criteria.Count -eq 0) { return '' }
    $min = ($Criteria | Measure-Object -Minimum).Minimum
    $max = ($Criteria | Measure-Object -Maximum).Maximum
    if ($min -eq $max) { return "S$Number.$min" }
    "S$Number.$min–S$Number.$max"
}

function New-LandedRow {
    param(
        [Parameter(Mandatory)][int]    $Number,
        [Parameter(Mandatory)][string] $Name,
        [Parameter(Mandatory)][int]    $Issue,
        [Parameter(Mandatory)][string] $CriteriaRange,
        [Parameter(Mandatory)][string] $Sha
    )
    "| **S$Number** | $Name | [#$Issue](../../issues/$Issue), closed | $CriteriaRange | ``$Sha`` |"
}

<#
    The main entry point. Read-only against the tracker (I13); the only file this ever writes
    is $SlicesPath, and only on a non-DryRun call that found at least one slice to retire.
#>
function Invoke-SlicesRetirement {
    param(
        [Parameter(Mandatory)][string] $SlicesPath,
        [string] $Repository,
        [switch] $DryRun
    )

    $doc = Get-SliceDocumentModel -Path $SlicesPath
    if ($doc.Failure) {
        return New-RetireResult -State 'NotEvaluated' -CouldNotEvaluate @($doc.Failure)
    }

    $tracker = Get-TrackerIssue -Repository $Repository
    if ($tracker.Failure) {
        return New-RetireResult -State 'NotEvaluated' -CouldNotEvaluate @($tracker.Failure)
    }

    $sha = Get-BodyCompleteAtSha -Path $SlicesPath
    if (-not $sha) {
        return New-RetireResult -State 'NotEvaluated' -CouldNotEvaluate @((New-RetireFailure -Reason 'ShallowCheckout' -Detail 'no history to resolve the body-complete-at commit'))
    }

    $retired = [System.Collections.Generic.List[object]]::new()
    $left    = [System.Collections.Generic.List[object]]::new()
    $rows    = [System.Collections.Generic.List[string]]::new()

    # Descending, so removing a later block never invalidates an earlier one's line numbers.
    foreach ($slice in ($doc.Slices | Sort-Object -Property StartLine -Descending)) {
        $issue = $tracker.Issues | Where-Object { $_.title -match "^S$($slice.Number)\b" } | Select-Object -First 1

        if (-not $issue) {
            $left.Add([pscustomobject]@{ Number = $slice.Number; Reason = 'NoIssue' })
            continue
        }
        if ($issue.state -ne 'CLOSED') {
            $left.Add([pscustomobject]@{ Number = $slice.Number; Reason = 'IssueOpen'; Issue = [int]$issue.number })
            continue
        }

        $range = Format-CriteriaRange -Number $slice.Number -Criteria $slice.Criteria
        $rows.Insert(0, (New-LandedRow -Number $slice.Number -Name $slice.Name -Issue ([int]$issue.number) -CriteriaRange $range -Sha $sha))
        $retired.Insert(0, [pscustomobject]@{ Number = $slice.Number; Name = $slice.Name; Issue = [int]$issue.number; Criteria = $range; Sha = $sha })

        # Remove the block: its heading line through EndLine, plus the blank line that follows
        # it if one is there, so retiring every slice under a heading leaves that heading with
        # a single trailing blank rather than an accumulating run of them.
        $removeEnd = $slice.EndLine
        if ($removeEnd + 1 -lt $doc.Lines.Count -and [string]::IsNullOrWhiteSpace($doc.Lines[$removeEnd + 1])) {
            $removeEnd++
        }
        $head = if ($slice.StartLine -gt 0) { @($doc.Lines[0..($slice.StartLine - 1)]) } else { @() }
        $doc.Lines = $head + (Get-ArraySlice -Array $doc.Lines -From ($removeEnd + 1))
    }

    if ($retired.Count -eq 0) {
        return New-RetireResult -State 'Clean' -Left @($left)
    }

    # Re-locate the Landed table's header separator (`|---|...|`) in the (possibly shrunk)
    # line array, and insert the new rows directly after it - table rows stay contiguous and
    # numeric slice order is preserved because $rows was built ascending above.
    $landedIdx = -1
    for ($i = 0; $i -lt $doc.Lines.Count; $i++) {
        if ($doc.Lines[$i] -match '^##\s+Landed\s*$') { $landedIdx = $i; break }
    }
    $sepIdx = -1
    for ($i = $landedIdx; $i -lt $doc.Lines.Count; $i++) {
        if ($doc.Lines[$i] -match '^\|\s*-+\s*\|') { $sepIdx = $i; break }
    }
    if ($sepIdx -lt 0) {
        return New-RetireResult -State 'NotEvaluated' -CouldNotEvaluate @((New-RetireFailure -Reason 'NoLandedTable' -Detail $SlicesPath))
    }

    $lastRowIdx = $sepIdx
    for ($i = $sepIdx + 1; $i -lt $doc.Lines.Count; $i++) {
        if ($doc.Lines[$i] -match '^\|') { $lastRowIdx = $i } else { break }
    }

    $newLines = @($doc.Lines[0..$lastRowIdx]) + @($rows) + (Get-ArraySlice -Array $doc.Lines -From ($lastRowIdx + 1))

    if (-not $DryRun) {
        $text = (($newLines -join "`n") + "`n")
        Set-Content -LiteralPath $SlicesPath -Value $text -NoNewline -Encoding utf8NoBOM
    }

    New-RetireResult -State 'Retired' -Retired @($retired) -Left @($left)
}

# Guards the invocation so this script's tests can dot-source it - the same shape
# Test-DesignDrift.ps1 and Update-WorkMirror.ps1 both use.
if ($MyInvocation.InvocationName -ne '.') {
    if (-not $SlicesPath) {
        $SlicesPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'design/30-slices.md'
    }

    $result = Invoke-SlicesRetirement -SlicesPath $SlicesPath -Repository $Repository -DryRun:$DryRun

    if (-not $Quiet) {
        switch ($result.State) {
            'NotEvaluated' { foreach ($f in $result.CouldNotEvaluate) { Write-Warning "Update-SlicesDocument: $($f.Reason) - $($f.Detail)" } }
            'Clean'        { Write-Host 'No landed slice found under Outstanding with a body still present.' }
            'Retired'      {
                foreach ($r in $result.Retired) { Write-Host "Retired S$($r.Number) — $($r.Name) (#$($r.Issue), $($r.Criteria), $($r.Sha))" }
                foreach ($l in $result.Left)    { Write-Host "Left S$($l.Number) in Outstanding: $($l.Reason)$(if ($l.Issue) { " (#$($l.Issue))" })" }
                if ($DryRun) { Write-Host "Dry run: $SlicesPath was not written." }
            }
        }
    }

    $result
    if ($result.State -eq 'NotEvaluated') { exit 2 }
    exit 0
}
