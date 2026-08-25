#Requires -Version 7.0
<#
.SYNOPSIS
    Checks that every `design/10-design.md` § *Section* citation in .claude/commands/*.md
    resolves to a heading the document actually contains.

.DESCRIPTION
    Issue #210: a command file can cite a section of design/10-design.md that was never
    written, and nothing catches it - the guard that was supposed to gate on the orientation
    mechanism instead happened to pass because design/state/ exists for an unrelated reason
    (it is /track's WorkRef mirror). Five command files carried a dangling reference to
    `§ Record` and `§ Orient` as a result.

    This is set arithmetic over files (AGENTS.md, "What should stop being model work" - the
    red row): extract every `design/10-design.md` § *Name* citation from .claude/commands/*.md,
    and resolve each Name against the `##`/`###` headings design/10-design.md actually has.
    A citation whose Name is not a heading is a finding.

    Exit codes: 0 every citation resolves, 1 at least one does not, 2 could not evaluate
    (commands directory or the design doc is missing). 2 takes precedence over 1, same as
    Test-DesignDrift.ps1 - an incomplete run is not a clean run. Never prompts.

.PARAMETER TargetRepo
    Repository to check. Defaults to the current directory.

.PARAMETER Quiet
    Suppress the printed report; the result object and exit code are unchanged.

.EXAMPLE
    ./tools/Test-DesignReferences.ps1
    Check this repository's command files against its own design doc.
#>
[CmdletBinding()]
param(
    [string] $TargetRepo = (Get-Location).Path,
    [switch] $Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
    Every `design/10-design.md` § *Name* citation in one file, with the line it appears on.
    The backtick-fenced path, then a section sign, then the name in single-asterisk emphasis -
    the exact shape every existing citation uses (contract.md, design.md, fix.md, reconcile.md,
    slice.md).
#>
function Get-DesignReferenceCitation {
    param([Parameter(Mandatory)][string] $Path)

    $text = [System.IO.File]::ReadAllText($Path) -replace "`r`n", "`n"
    $lines = $text -split "`n"
    $citations = [System.Collections.Generic.List[object]]::new()

    for ($i = 0; $i -lt $lines.Count; $i++) {
        foreach ($m in [regex]::Matches($lines[$i], '`design/10-design\.md`\s*§\s*\*([^*]+)\*')) {
            $citations.Add([pscustomobject]@{
                    Name = $m.Groups[1].Value.Trim()
                    Line = $i + 1
                })
        }
    }
    , @($citations)
}

<#
    The `##` and `###` heading text of design/10-design.md, trimmed the same way a citation's
    Name is - so "Record" resolves against a heading literally titled "Record", not a
    substring match that would let a near-miss silently pass.
#>
function Get-DesignHeading {
    param([Parameter(Mandatory)][string] $DesignDoc)

    $text = [System.IO.File]::ReadAllText($DesignDoc) -replace "`r`n", "`n"
    $headings = [System.Collections.Generic.List[string]]::new()
    foreach ($m in [regex]::Matches($text, '(?m)^#{2,3}[ \t]+(.+?)[ \t]*$')) {
        $headings.Add($m.Groups[1].Value.Trim())
    }
    , @($headings)
}

function New-DesignReferenceFinding {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][int] $Line,
        [Parameter(Mandatory)][string] $Name
    )
    [pscustomobject]@{ Path = $Path; Line = $Line; Name = $Name }
}

function Invoke-DesignReferenceCheck {
    param([Parameter(Mandatory)][string] $TargetRepo)

    $commandsDir = Join-Path $TargetRepo '.claude/commands'
    $designDoc = Join-Path $TargetRepo 'design/10-design.md'

    if (-not (Test-Path -LiteralPath $commandsDir)) {
        return [pscustomobject]@{
            State = 'NotEvaluated'; Findings = @(); CitationCount = 0
            Detail = "'$TargetRepo' has no .claude/commands/ directory."
        }
    }
    if (-not (Test-Path -LiteralPath $designDoc)) {
        return [pscustomobject]@{
            State = 'NotEvaluated'; Findings = @(); CitationCount = 0
            Detail = "'$TargetRepo' has no design/10-design.md - there is nothing to resolve citations against."
        }
    }

    $headings = Get-DesignHeading -DesignDoc $designDoc
    $findings = [System.Collections.Generic.List[object]]::new()
    $citationCount = 0

    $files = @(Get-ChildItem -LiteralPath $commandsDir -Filter '*.md' -File | Sort-Object Name)
    foreach ($file in $files) {
        $rel = ".claude/commands/$($file.Name)"
        foreach ($citation in (Get-DesignReferenceCitation -Path $file.FullName)) {
            $citationCount++
            if ($headings -notcontains $citation.Name) {
                $findings.Add((New-DesignReferenceFinding $rel $citation.Line $citation.Name))
            }
        }
    }

    [pscustomobject]@{
        State         = if ($findings.Count -gt 0) { 'Invalid' } else { 'Valid' }
        Findings      = @($findings)
        CitationCount = $citationCount
        Detail        = ''
    }
}

function Get-DesignReferenceExitCode {
    param([string] $State)
    switch ($State) {
        'Valid'        { 0 }
        'Invalid'      { 1 }
        'NotEvaluated' { 2 }
        default        { throw "Unknown design-reference state: $State" }
    }
}

function Write-DesignReferenceReport {
    param([Parameter(Mandatory)][object] $Result)

    switch ($Result.State) {
        'Valid' {
            Write-Host "Design references OK - $($Result.CitationCount) citation(s) checked, all resolve to a real heading."
        }
        'Invalid' {
            Write-Host "Design references BROKEN - $($Result.Findings.Count) of $($Result.CitationCount) citation(s) do not resolve:"
            foreach ($f in $Result.Findings) { Write-Host "  $($f.Path):$($f.Line) - `` design/10-design.md`` has no `"$($f.Name)`" heading" }
        }
        'NotEvaluated' {
            Write-Host "Could not evaluate: $($Result.Detail)"
        }
    }
}

# Guarded so the tests can dot-source this instead - same structure as Test-Companion.ps1 and
# Test-DesignDrift.ps1, and for the same reason.
if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-DesignReferenceCheck -TargetRepo $TargetRepo
    if (-not $Quiet) { Write-DesignReferenceReport -Result $result }
    $result
    exit (Get-DesignReferenceExitCode -State $result.State)
}
