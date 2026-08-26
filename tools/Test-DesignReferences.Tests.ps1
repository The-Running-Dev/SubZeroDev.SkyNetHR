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

    It 'reports this repository''s current five dangling citations - the exact regression from issue #210' {
        # Not a fixture: the real repository root, one level up from tools/. If /design
        # later writes § Record and § Orient, this test starts failing - which is correct,
        # since it would mean the fix landed and this expectation is stale.
        $repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

        $result = Invoke-DesignReferenceCheck -TargetRepo $repoRoot

        $result.State | Should -Be 'Invalid'
        $result.Findings.Count | Should -Be 5
        ($result.Findings | Where-Object Name -eq 'Record').Count | Should -Be 3
        ($result.Findings | Where-Object Name -eq 'Orient').Count | Should -Be 2
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
