#Requires -Version 7.0
#Requires -Modules Pester

<#
  Test-DesignReferences.ps1 exits the process on every path (0/1/2), so these tests
  dot-source it - same structure as Test-Companion.ps1 and Test-DesignDrift.ps1.

  Regression coverage for issue #210: a citation can point at a section that was never
  written, and the previous state of this repository had nothing that caught it. The
  fixture below reproduces that exact shape - a citation to a heading the design doc
  does not have - to make sure this script is the thing that now catches it.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Test-DesignReferences.ps1'
    . $script:ScriptPath -TargetRepo $TestDrive

    function New-Fixture {
        param([Parameter(Mandatory)][string] $Name)
        $repo = Join-Path $TestDrive $Name
        New-Item -ItemType Directory -Path (Join-Path $repo '.claude/commands') -Force | Out-Null
        $repo
    }

    function Write-Fixture {
        param([Parameter(Mandatory)][string] $Repo, [Parameter(Mandatory)][string] $RelPath, [Parameter(Mandatory)][AllowEmptyString()][string] $Content)
        $full = Join-Path $Repo $RelPath
        $parent = Split-Path -Parent $full
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        [System.IO.File]::WriteAllText($full, $Content, [System.Text.UTF8Encoding]::new($false))
    }

    $script:DesignDocWithSections = @(
        '# Design — Fixture'
        ''
        '## Shape'
        ''
        'Body.'
        ''
        '## Orient'
        ''
        'Body.'
        ''
        '### Record'
        ''
        'Body.'
    ) -join "`n"

    $script:DesignDocNoSections = @(
        '# Design — Fixture'
        ''
        '## Shape'
        ''
        'Body.'
    ) -join "`n"
}

Describe 'Test-DesignReferences' {

    It 'is Valid when no command file cites design/10-design.md at all' {
        $repo = New-Fixture 'no-citations'
        Write-Fixture $repo 'design/10-design.md' $script:DesignDocNoSections
        Write-Fixture $repo '.claude/commands/slice.md' 'Nothing here cites the design doc.'

        $result = Invoke-DesignReferenceCheck -TargetRepo $repo

        $result.State | Should -Be 'Valid'
        $result.Findings.Count | Should -Be 0
        $result.CitationCount | Should -Be 0
        (Get-DesignReferenceExitCode -State $result.State) | Should -Be 0
    }

    It 'is Valid when every citation resolves to a real heading' {
        $repo = New-Fixture 'resolving-citations'
        Write-Fixture $repo 'design/10-design.md' $script:DesignDocWithSections
        Write-Fixture $repo '.claude/commands/slice.md' 'See `design/10-design.md` § *Orient* for how to orient.'
        Write-Fixture $repo '.claude/commands/contract.md' 'See `design/10-design.md` § *Record* for how to record.'

        $result = Invoke-DesignReferenceCheck -TargetRepo $repo

        $result.State | Should -Be 'Valid'
        $result.Findings.Count | Should -Be 0
        $result.CitationCount | Should -Be 2
    }

    It 'is Invalid, naming file, line and section, when a citation names a heading the doc does not have' {
        $repo = New-Fixture 'dangling-citation'
        Write-Fixture $repo 'design/10-design.md' $script:DesignDocNoSections
        Write-Fixture $repo '.claude/commands/slice.md' ((@(
            'line one'
            'See `design/10-design.md` § *Orient* for how to orient.'
        )) -join "`n")

        $result = Invoke-DesignReferenceCheck -TargetRepo $repo

        $result.State | Should -Be 'Invalid'
        $result.Findings.Count | Should -Be 1
        $result.Findings[0].Path | Should -Be '.claude/commands/slice.md'
        $result.Findings[0].Line | Should -Be 2
        $result.Findings[0].Name | Should -Be 'Orient'
        (Get-DesignReferenceExitCode -State $result.State) | Should -Be 1
    }

    It 'is Valid for this repository''s current five citations - each is conditional on design/state/''s record mechanism, which this repository has not adopted (D188)' {
        # Not a fixture: the real repository root, one level up from tools/. This repository's
        # design/state/work/ is /track's WorkRef mirror only - no units/invariants/contracts/
        # decisions/questions directory exists - so all five citations are skipped rather than
        # required to resolve. If this repository later adopts the record mechanism, or if
        # /design writes § Record and § Orient outright, this test starts failing - which is
        # correct, since it would mean the shape this test describes is stale.
        $repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

        $result = Invoke-DesignReferenceCheck -TargetRepo $repoRoot

        $result.State | Should -Be 'Valid'
        $result.Findings.Count | Should -Be 0
        $result.CitationCount | Should -Be 5
    }

    It 'skips a conditional citation when design/state/ has no adopted record-kind directory' {
        $repo = New-Fixture 'conditional-citation-no-state'
        Write-Fixture $repo 'design/10-design.md' $script:DesignDocNoSections
        Write-Fixture $repo '.claude/commands/fix.md' 'Where this repository''s own `design/state/` exists, see `design/10-design.md` § *Orient* for the closure.'

        $result = Invoke-DesignReferenceCheck -TargetRepo $repo

        $result.State | Should -Be 'Valid'
        $result.Findings.Count | Should -Be 0
        $result.CitationCount | Should -Be 1
    }

    It 'still enforces a conditional citation once a record-kind directory is present' {
        $repo = New-Fixture 'conditional-citation-with-state'
        Write-Fixture $repo 'design/10-design.md' $script:DesignDocNoSections
        Write-Fixture $repo '.claude/commands/fix.md' 'Where this repository''s own `design/state/` exists, see `design/10-design.md` § *Orient* for the closure.'
        New-Item -ItemType Directory -Path (Join-Path $repo 'design/state/units') -Force | Out-Null

        $result = Invoke-DesignReferenceCheck -TargetRepo $repo

        $result.State | Should -Be 'Invalid'
        $result.Findings.Count | Should -Be 1
        $result.Findings[0].Name | Should -Be 'Orient'
    }

    It 'does not let a populated work/ mirror alone count as the record mechanism being adopted' {
        $repo = New-Fixture 'work-mirror-only'
        Write-Fixture $repo 'design/10-design.md' $script:DesignDocNoSections
        Write-Fixture $repo '.claude/commands/fix.md' 'Where this repository''s own `design/state/` exists, see `design/10-design.md` § *Orient* for the closure.'
        Write-Fixture $repo 'design/state/work/1.md' "# work/1`nIssue: 1`n"

        $result = Invoke-DesignReferenceCheck -TargetRepo $repo

        $result.State | Should -Be 'Valid'
        $result.Findings.Count | Should -Be 0
    }

    It 'still fails an unconditional citation regardless of design/state/''s adoption' {
        $repo = New-Fixture 'unconditional-still-fails'
        Write-Fixture $repo 'design/10-design.md' $script:DesignDocNoSections
        Write-Fixture $repo '.claude/commands/slice.md' 'See `design/10-design.md` § *Orient* for how to orient.'

        $result = Invoke-DesignReferenceCheck -TargetRepo $repo

        $result.State | Should -Be 'Invalid'
        $result.Findings.Count | Should -Be 1
    }

    It 'is NotEvaluated when .claude/commands/ is missing' {
        $repo = Join-Path $TestDrive 'no-commands-dir'
        New-Item -ItemType Directory -Path $repo -Force | Out-Null
        Write-Fixture $repo 'design/10-design.md' $script:DesignDocNoSections

        $result = Invoke-DesignReferenceCheck -TargetRepo $repo

        $result.State | Should -Be 'NotEvaluated'
        (Get-DesignReferenceExitCode -State $result.State) | Should -Be 2
    }

    It 'is NotEvaluated when design/10-design.md is missing' {
        $repo = New-Fixture 'no-design-doc'

        $result = Invoke-DesignReferenceCheck -TargetRepo $repo

        $result.State | Should -Be 'NotEvaluated'
        (Get-DesignReferenceExitCode -State $result.State) | Should -Be 2
    }
}
