#Requires -Version 7.0
#Requires -Modules Pester

<#
  Same dot-source shape as Test-DesignDrift.Tests.ps1: the script exits the process on every
  path, so dot-sourcing defines its functions here and skips the exit-calling wrapper.
  `Invoke-SlicesRetirement` is called directly. `Get-TrackerIssue` is mocked at the function
  seam, the same boundary Test-DesignDrift.Tests.ps1 mocks at, rather than at `gh` itself.

  Every fixture document is written into $TestDrive as a real git-tracked file, so
  Get-BodyCompleteAtSha has real history to read - a bare Set-Content with no commit would make
  every case a ShallowCheckout failure rather than exercising the retirement it means to test.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Update-SlicesDocument.ps1'
    $script:PreDotSourceErrorActionPreference = $ErrorActionPreference
    . $script:ScriptPath

    function New-Issue {
        param([int] $Number, [string] $Title, [string] $State = 'OPEN', [string] $Body = '')
        [pscustomobject]@{ number = $Number; title = $Title; state = $State; body = $Body }
    }

    function New-Tracker {
        param([object[]] $Issues = @())
        [pscustomobject]@{ Issues = @($Issues); Failure = $null }
    }

    # Writes the fixture into a throwaway git repo so `git log -- <path>` resolves to a real
    # commit, then returns the file's path.
    function New-GitSlicesDoc {
        param([Parameter(Mandatory)][string] $Content)
        $repoDir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $repoDir | Out-Null
        Push-Location $repoDir
        try {
            & git init --quiet
            & git config user.email 'test@example.com'
            & git config user.name 'Test'
            $path = Join-Path $repoDir 'slices.md'
            Set-Content -LiteralPath $path -Value $Content -Encoding utf8
            & git add slices.md
            & git commit --quiet -m 'fixture'
        } finally {
            Pop-Location
        }
        $path
    }

    $script:TwoOutstandingDoc = @'
# Slices

## Outstanding

### S23 — First landed slice
Delivers: something.
Acceptance:
  - S23.1 first criterion.
  - S23.2 second criterion.
  - S23.3 third criterion.

### S24 — Second, still open
Delivers: something else.
Acceptance:
  - S24.1 first criterion.

## Landed

| Slice | Name | Issue | Criteria | Body complete at |
|---|---|---|---|---|
| **S1** | Wait for a pull request's checks | [#9](../../issues/9), closed | S1.1–S1.10 | `af610a6` |
'@
}

AfterAll {
    $ErrorActionPreference = $script:PreDotSourceErrorActionPreference
    Set-StrictMode -Off
}

Describe 'Update-SlicesDocument' {

    Context 'Get-SliceDocumentModel' {
        It 'finds each numbered slice block under Outstanding, with its criteria ids' {
            $path = New-GitSlicesDoc -Content $script:TwoOutstandingDoc
            $doc = Get-SliceDocumentModel -Path $path

            $doc.Failure | Should -BeNullOrEmpty
            $doc.Slices.Count | Should -Be 2
            ($doc.Slices | Where-Object Number -eq 23).Criteria | Should -Be @(1, 2, 3)
            ($doc.Slices | Where-Object Number -eq 23).Name | Should -Be 'First landed slice'
        }

        It 'reports NoOutstandingSection when the heading is missing' {
            $path = New-GitSlicesDoc -Content "# Slices`n`n## Landed`n"
            (Get-SliceDocumentModel -Path $path).Failure.Reason | Should -Be 'NoOutstandingSection'
        }

        It 'stops the last slice at a following non-slice heading rather than swallowing it' {
            # design/30-slices.md carries two evergreen `### ` notes ("A note on counts",
            # "Interim findings are expected") after the last numbered slice and before
            # `## Landed`. A parser that bounds every slice's end at the Landed marker
            # unconditionally would fold both notes into the last slice's body and delete them
            # the moment that slice retires - this is the regression that caught it.
            $path = New-GitSlicesDoc -Content @'
# Slices

## Outstanding

### S23 — Only slice
Delivers: something.
Acceptance:
  - S23.1 first criterion.

### A note on counts

This note must survive S23 retiring.

### Interim findings are expected

So must this one.

## Landed
'@
            $doc = Get-SliceDocumentModel -Path $path

            $doc.Failure | Should -BeNullOrEmpty
            $doc.Slices.Count | Should -Be 1
            $doc.Lines[$doc.Slices[0].EndLine] | Should -Not -Match 'must survive|So must this'
        }
    }

    Context 'Invoke-SlicesRetirement' {
        It 'retires a slice whose issue is closed, and leaves one whose issue is open' {
            $path = New-GitSlicesDoc -Content $script:TwoOutstandingDoc
            Mock Get-TrackerIssue { New-Tracker -Issues @(
                (New-Issue -Number 200 -Title 'S23 — First landed slice' -State 'CLOSED'),
                (New-Issue -Number 201 -Title 'S24 — Second, still open' -State 'OPEN')
            ) }

            $r = Invoke-SlicesRetirement -SlicesPath $path

            $r.State | Should -Be 'Retired'
            $r.Retired.Count | Should -Be 1
            $r.Retired[0].Number | Should -Be 23
            $r.Retired[0].Criteria | Should -Be 'S23.1–S23.3'
            $r.Left.Count | Should -Be 1
            $r.Left[0].Reason | Should -Be 'IssueOpen'

            $written = Get-Content -LiteralPath $path -Raw
            $written | Should -Not -Match 'S23 — First landed slice'
            $written | Should -Match 'S24 — Second, still open'
            $written | Should -Match '\| \*\*S23\*\* \| First landed slice \| \[#200\]\(\.\./\.\./issues/200\), closed \| S23\.1–S23\.3 \| `[0-9a-f]{7}` \|'
            # The retained S1 row is untouched and still precedes the newly appended one.
            ($written -split "`n" | Where-Object { $_ -match '^\|\s*\*\*S' }).Count | Should -Be 2
        }

        It 'leaves a slice with no matching issue untouched, and is otherwise a no-op' {
            $path = New-GitSlicesDoc -Content $script:TwoOutstandingDoc
            Mock Get-TrackerIssue { New-Tracker -Issues @() }

            $r = Invoke-SlicesRetirement -SlicesPath $path

            $r.State | Should -Be 'Clean'
            $r.Left.Count | Should -Be 2
            ($r.Left | ForEach-Object Reason) | Should -Contain 'NoIssue'
            (Get-Content -LiteralPath $path -Raw) | Should -Be (Get-Content -LiteralPath $path -Raw)
        }

        It 'DryRun reports the retirement without writing the file' {
            $path = New-GitSlicesDoc -Content $script:TwoOutstandingDoc
            $before = Get-Content -LiteralPath $path -Raw
            Mock Get-TrackerIssue { New-Tracker -Issues @(
                (New-Issue -Number 200 -Title 'S23 — First landed slice' -State 'CLOSED')
            ) }

            $r = Invoke-SlicesRetirement -SlicesPath $path -DryRun

            $r.State | Should -Be 'Retired'
            $r.Retired.Count | Should -Be 1
            (Get-Content -LiteralPath $path -Raw) | Should -Be $before
        }

        It 'retires two adjacent closed slices in one pass, in ascending order in the table' {
            $doc = @'
# Slices

## Outstanding

### S23 — First
Delivers: a.
Acceptance:
  - S23.1 a.

### S24 — Second
Delivers: b.
Acceptance:
  - S24.1 b.

## Landed

| Slice | Name | Issue | Criteria | Body complete at |
|---|---|---|---|---|
| **S1** | Existing | [#9](../../issues/9), closed | S1.1 | `af610a6` |
'@
            $path = New-GitSlicesDoc -Content $doc
            Mock Get-TrackerIssue { New-Tracker -Issues @(
                (New-Issue -Number 200 -Title 'S23 — First' -State 'CLOSED'),
                (New-Issue -Number 201 -Title 'S24 — Second' -State 'CLOSED')
            ) }

            $r = Invoke-SlicesRetirement -SlicesPath $path
            $r.Retired.Count | Should -Be 2

            $rows = (Get-Content -LiteralPath $path) | Where-Object { $_ -match '^\|\s*\*\*S' }
            $rows[0] | Should -Match '\*\*S1\*\*'
            $rows[1] | Should -Match '\*\*S23\*\*'
            $rows[2] | Should -Match '\*\*S24\*\*'
            $outstanding = (Get-Content -LiteralPath $path -Raw)
            $outstanding | Should -Not -Match '### S23'
            $outstanding | Should -Not -Match '### S24'
        }

        It 'retires the last slice under Outstanding without deleting a trailing evergreen note' {
            $doc = @'
# Slices

## Outstanding

### S23 — Only slice
Delivers: something.
Acceptance:
  - S23.1 first criterion.

### A note on counts

This note must survive.

## Landed

| Slice | Name | Issue | Criteria | Body complete at |
|---|---|---|---|---|
| **S1** | Existing | [#9](../../issues/9), closed | S1.1 | `af610a6` |
'@
            $path = New-GitSlicesDoc -Content $doc
            Mock Get-TrackerIssue { New-Tracker -Issues @(
                (New-Issue -Number 200 -Title 'S23 — Only slice' -State 'CLOSED')
            ) }

            $r = Invoke-SlicesRetirement -SlicesPath $path
            $r.State | Should -Be 'Retired'

            $written = Get-Content -LiteralPath $path -Raw
            $written | Should -Not -Match '### S23'
            $written | Should -Match 'This note must survive\.'
            $written | Should -Match '### A note on counts'
        }

        It 'reports GhUnavailable as NotEvaluated rather than treating every slice as un-landed' {
            $path = New-GitSlicesDoc -Content $script:TwoOutstandingDoc
            Mock Get-TrackerIssue { [pscustomobject]@{ Issues = @(); Failure = (New-RetireFailure -Reason 'GhUnavailable' -Detail 'gh exited 1') } }

            $r = Invoke-SlicesRetirement -SlicesPath $path

            $r.State | Should -Be 'NotEvaluated'
            $r.CouldNotEvaluate[0].Reason | Should -Be 'GhUnavailable'
        }
    }

    Context 'Format-CriteriaRange' {
        It 'formats a multi-criterion slice as min–max' {
            Format-CriteriaRange -Number 23 -Criteria @(1, 2, 3, 9) | Should -Be 'S23.1–S23.9'
        }
        It 'formats a single-criterion slice without a dash' {
            Format-CriteriaRange -Number 5 -Criteria @(4) | Should -Be 'S5.4'
        }
        It 'formats an empty criteria set as an empty string, not a throw' {
            Format-CriteriaRange -Number 5 -Criteria @() | Should -Be ''
        }
    }
}
