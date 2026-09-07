#Requires -Version 7.0
#Requires -Modules Pester

<#
  Test-DesignState.ps1 exits the process on real invocation (0/1/2), so these tests dot-source
  it purely to reuse its functions and skip its own invocation block - the same guard shape
  Test-DesignDrift.ps1, Wait-PullRequestCheck.ps1 and Read-DesignState.ps1 already use.

  Every fixture below is written into $TestDrive under a throwaway root; the final Describe
  block is explicit about reading the containing checkout's own tree instead - it and the other
  self-referential blocks below assert on adopted design-state content, which only this
  repository has: the 2026-08-19 compatibility promise (design/90-decisions.md) leaves the
  installed targets unmigrated, and this file is copied into every one of them. So they are
  skipped wherever design/state/units/ is absent - false and unevaluated rather than a false pass or a
  false failure, the same way Test-DesignState.ps1 itself reports StateSetAbsent and exits 2
  rather than a silent 0.
#>

$script:DesignStateSelfTestRoot = Split-Path $PSScriptRoot -Parent
$script:SkipDesignStateSelfTests = -not (Test-Path (Join-Path $script:DesignStateSelfTestRoot 'design/state/units'))

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Test-DesignState.ps1'
    . $script:ScriptPath -Path $TestDrive

    function New-StateFile {
        param([Parameter(Mandatory)][string] $RelativePath, [Parameter(Mandatory)][string] $Content)
        $full = Join-Path $TestDrive (Join-Path 'design/state' $RelativePath)
        New-Item -ItemType Directory -Path (Split-Path $full -Parent) -Force | Out-Null
        Set-Content -LiteralPath $full -Value $Content -Encoding utf8NoBOM
        $full
    }

    function New-TreeFile {
        param([Parameter(Mandatory)][string] $RelativePath, [Parameter(Mandatory)][string] $Content)
        $full = Join-Path $TestDrive $RelativePath
        New-Item -ItemType Directory -Path (Split-Path $full -Parent) -Force | Out-Null
        Set-Content -LiteralPath $full -Value $Content -Encoding utf8NoBOM
        $full
    }

    function New-Record {
        param(
            [Parameter(Mandatory)][string] $Id,
            [string] $Kind = 'Unit',
            [hashtable] $Scalars = @{},
            [hashtable] $Lists = @{},
            [hashtable] $Prose = @{},
            [string] $Path = 'design/state/units/command/placeholder.md'
        )
        New-DesignRecord -Id $Id -Kind $Kind -Path $Path -Scalars $Scalars -Lists $Lists -Prose $Prose
    }

    # A record file of an exact byte length, for the two sides of the closure ceiling. Shared by
    # the ClosureOverBudget pair below so the boundary case and its near-miss are built the same
    # way and differ only in the one number under test.
    function New-ExactSizeRecord {
        param([Parameter(Mandatory)][string] $Slug, [Parameter(Mandatory)][int] $TotalBytes)
        $header = "# unit/command/$Slug`nKind: command`n"
        $pad = $TotalBytes - [System.Text.Encoding]::UTF8.GetByteCount($header)
        $content = $header + ('z' * $pad)
        $full = Join-Path $TestDrive "design/state/units/command/$Slug.md"
        New-Item -ItemType Directory -Path (Split-Path $full -Parent) -Force | Out-Null
        [System.IO.File]::WriteAllText($full, $content, [System.Text.UTF8Encoding]::new($false))
        $full
    }

    # A minimal but exact stand-in for the two sections of design/20-contract.md the checker
    # parses about itself - the same 32 class ids Test-DesignState.ps1 declares, and a verbatim
    # copy of § "Artifacts of a unit kind"'s table - so end-to-end tests below do not spuriously
    # raise ClassListDisagreement or GlobDisagreement while exercising something else entirely.
    # The glob table agrees with the enumeration over any tree by construction, which is exactly
    # the property GlobDisagreement exists to keep true of the real document.
    $script:MinimalContract = @'
### Artifacts of a unit kind

| Kind | Glob | Excluded |
|---|---|---|
| command | `.claude/commands/*.md` | `*-local.md` |
| script | `tools/*.ps1` | `*.Tests.ps1` |
| document | `design/*.md`, `templates/design/*.md`, `*.md`, `.claude/COMPANIONS.md`, `.github/ISSUE_TEMPLATE/*.md`, `codex/PROFILES.md` | `design/FROZEN.md`, `CLAUDE.md` |
| invariant | not a tree path | — |

### The divergence classes

**This is the closed list.**

**Blocking.**

| Class | Raised when | Caller sees |
|---|---|---|
| `UnresolvedId` | x | x |
| `AnchorMissing` | x | x |
| `OwnerMismatch` | x | x |
| `UnrecordedArtifact` | x | x |
| `ProjectionStale` | x | x |
| `RegionMalformed` | x | x |
| `IdCollision` | x | x |
| `DecisionAnchorAmbiguous` | x | x |
| `LogEntryUnrecorded` | x | x |
| `EnforcementUnevidenced` | x | x |
| `ClosureOverBudget` | x | x |
| `ClassListDisagreement` | x | x |
| `GlobDisagreement` | x | x |
| `RecordPairMalformed` | x | x |
| `HalfStatusMismatch` | x | x |
| `HalfOverlap` | x | x |
| `SiteAmbiguous` | x | x |
| `SiteOutOfReach` | x | x |
| `SiteContradictsLive` | x | x |
| `DecisionUnplaced` | x | x |
| `SupersessionCycle` | x | x |

**Reported, never blocking.**

| Class | Raised when | Why it never blocks |
|---|---|---|
| `MirrorStale` | x | x |
| `WorkStateDivergence` | x | x |
| `PinAncestry` | x | x |
| `SemanticDisagreement` | x | x |
| `LiveAlreadyStated` | x | x |

**Could not evaluate.**

| `DesignStateFailure` | Raised when | Caller does |
|---|---|---|
| `StateSetAbsent` | x | x |
| `RecordUnparseable` | x | x |
| `TrackerUnavailable` | x | x |
| `ShallowCheckout` | x | x |
| `ProjectorFailed` | x | x |
| `ContractListUnreadable` | x | x |

### The freeze

## Invariants

| | Statement | Owner | Enforcement | Evidence |
|---|---|---|---|---|

## Unresolved
'@
}

AfterAll {
    Get-ChildItem $TestDrive -ErrorAction SilentlyContinue -Recurse -File |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

Describe 'Test-DesignState: id resolution and record-level classes' {

    It 'S5.1: UnresolvedId fires when a list field names an id with no record' -Tag 'Fires','UnresolvedId' {
        $a = New-Record -Id 'unit/command/a' -Lists @{ Binds = @('I999') }
        $findings = Test-UnresolvedId -ById @{ 'unit/command/a' = $a } -Records @($a)
        $findings.Count | Should -Be 1
        $findings[0].Class | Should -Be 'UnresolvedId'
        $findings[0].Subject | Should -Be 'unit/command/a'
    }

    It 'UnresolvedId does not fire for a retired id a live record names (still resolvable)' -Tag 'NearMiss','UnresolvedId' {
        $a = New-Record -Id 'unit/command/a' -Lists @{ Live = @('decision/x') }
        $d = New-Record -Id 'decision/x' -Kind 'Decision' -Scalars @{ Status = 'retired' }
        $findings = Test-UnresolvedId -ById @{ 'unit/command/a' = $a; 'decision/x' = $d } -Records @($a, $d)
        $findings.Count | Should -Be 0
    }

    It 'UnresolvedId does not check Work or Evidence - they are not design-state ids' -Tag 'NearMiss','UnresolvedId' {
        $a = New-Record -Id 'unit/command/a' -Lists @{ Work = @('42'); Evidence = @('tools/x.ps1') }
        $findings = Test-UnresolvedId -ById @{ 'unit/command/a' = $a } -Records @($a)
        $findings.Count | Should -Be 0
    }

    It 'S5.1: UnresolvedId also checks scalar id fields (Owner, SupersededBy, AnsweredBy)' -Tag 'Fires','UnresolvedId' {
        $c = New-Record -Id 'contract/x' -Kind 'Contract' -Scalars @{ Owner = 'unit/command/nobody' }
        $findings = Test-UnresolvedId -ById @{ 'contract/x' = $c } -Records @($c)
        $findings.Count | Should -Be 1
        $findings[0].Detail | Should -Match 'Owner'
    }

    It 'S5.1/module boundaries: AnchorMissing fires only for an active Unit whose Anchor is not in the tree' -Tag 'Fires','AnchorMissing' {
        $active = New-Record -Id 'unit/command/a' -Scalars @{ Status = 'active'; Kind = 'command'; Anchor = '.claude/commands/nope.md' }
        $retired = New-Record -Id 'unit/command/b' -Scalars @{ Status = 'retired'; Kind = 'command'; Anchor = '.claude/commands/also-nope.md' }
        $invariant = New-Record -Id 'I1' -Kind 'Invariant' -Scalars @{ Status = 'active'; Anchor = 'I1'; Kind = 'invariant' }

        $findings = Test-AnchorMissing -Records @($active, $retired, $invariant) -RepoPath $TestDrive

        $findings.Count | Should -Be 1
        $findings[0].Subject | Should -Be 'unit/command/a'
    }

    It 'AnchorMissing does not fire when the anchor exists' -Tag 'NearMiss','AnchorMissing' {
        New-TreeFile -RelativePath '.claude/commands/real.md' -Content 'hi'
        $active = New-Record -Id 'unit/command/a' -Scalars @{ Status = 'active'; Kind = 'command'; Anchor = '.claude/commands/real.md' }
        $findings = Test-AnchorMissing -Records @($active) -RepoPath $TestDrive
        $findings.Count | Should -Be 0
    }

    It 'AnchorMissing fires for a Contract Declaration that is not in the tree' -Tag 'Fires','AnchorMissing' {
        $c = New-Record -Id 'contract/x' -Kind 'Contract' -Scalars @{ Status = 'active'; Owner = 'unit/script/a'; Declaration = 'tools/Absent.ps1' }
        $findings = Test-AnchorMissing -Records @($c) -RepoPath $TestDrive
        $findings.Count | Should -Be 1
        $findings[0].Subject | Should -Be 'contract/x'
        $findings[0].Detail | Should -Match 'Declaration'
    }

    It 'AnchorMissing does not fire for a Contract Declaration of the literal prose, or one that resolves' -Tag 'NearMiss','AnchorMissing' {
        New-TreeFile -RelativePath 'tools/Present.ps1' -Content 'x'
        $prose = New-Record -Id 'contract/p' -Kind 'Contract' -Scalars @{ Status = 'active'; Owner = 'unit/command/a'; Declaration = 'prose' }
        $real = New-Record -Id 'contract/r' -Kind 'Contract' -Scalars @{ Status = 'active'; Owner = 'unit/script/a'; Declaration = 'tools/Present.ps1' }
        $retired = New-Record -Id 'contract/g' -Kind 'Contract' -Scalars @{ Status = 'retired'; Owner = 'unit/script/a'; Declaration = 'tools/Gone.ps1' }
        $findings = Test-AnchorMissing -Records @($prose, $real, $retired) -RepoPath $TestDrive
        $findings.Count | Should -Be 0
    }

    It 'AnchorMissing fires for an Evidence entry that is not in the tree, on a Unit and on an Invariant' -Tag 'Fires','AnchorMissing' {
        New-TreeFile -RelativePath '.claude/commands/anchored.md' -Content 'x'
        $unit = New-Record -Id 'unit/command/e' -Scalars @{ Status = 'active'; Kind = 'command'; Anchor = '.claude/commands/anchored.md' } -Lists @{ Evidence = @('tools/Nothing.Tests.ps1') }
        $inv = New-Record -Id 'I2' -Kind 'Invariant' -Scalars @{ Status = 'active'; Anchor = 'I2'; Kind = 'invariant'; Enforcement = 'code' } -Lists @{ Evidence = @('tools/AlsoNothing.Tests.ps1') }

        $findings = Test-AnchorMissing -Records @($unit, $inv) -RepoPath $TestDrive

        $findings.Count | Should -Be 2
        @($findings | ForEach-Object { $_.Subject }) | Should -Contain 'unit/command/e'
        @($findings | ForEach-Object { $_.Subject }) | Should -Contain 'I2'
        @($findings | ForEach-Object { $_.Detail }) | Should -Not -Contain $null
        $findings[0].Detail | Should -Match 'Evidence'
    }

    It 'AnchorMissing does not fire for an Evidence entry that resolves, or an empty Evidence list' -Tag 'NearMiss','AnchorMissing' {
        New-TreeFile -RelativePath '.claude/commands/anchored2.md' -Content 'x'
        New-TreeFile -RelativePath 'tools/Something.Tests.ps1' -Content 'x'
        $withEvidence = New-Record -Id 'unit/command/f' -Scalars @{ Status = 'active'; Kind = 'command'; Anchor = '.claude/commands/anchored2.md' } -Lists @{ Evidence = @('tools/Something.Tests.ps1') }
        $empty = New-Record -Id 'unit/command/g' -Scalars @{ Status = 'active'; Kind = 'command'; Anchor = '.claude/commands/anchored2.md' } -Lists @{ Evidence = @() }
        $findings = Test-AnchorMissing -Records @($withEvidence, $empty) -RepoPath $TestDrive
        $findings.Count | Should -Be 0
    }

    It 'S5.1: OwnerMismatch fires when nobody exposes the contract' -Tag 'Fires','OwnerMismatch' {
        $c = New-Record -Id 'contract/x' -Kind 'Contract' -Scalars @{ Owner = 'unit/command/a'; Status = 'active' }
        $findings = Test-OwnerMismatch -Records @($c)
        $findings.Count | Should -Be 1
        $findings[0].Detail | Should -Match 'nobody'
    }

    It 'OwnerMismatch fires when two units expose the same contract' -Tag 'Fires','OwnerMismatch' {
        $c = New-Record -Id 'contract/x' -Kind 'Contract' -Scalars @{ Owner = 'unit/command/a'; Status = 'active' }
        $a = New-Record -Id 'unit/command/a' -Scalars @{ Status = 'active' } -Lists @{ Exposes = @('contract/x') }
        $b = New-Record -Id 'unit/command/b' -Scalars @{ Status = 'active' } -Lists @{ Exposes = @('contract/x') }
        $findings = Test-OwnerMismatch -Records @($c, $a, $b)
        $findings.Count | Should -Be 1
    }

    It 'OwnerMismatch does not fire for the unique active exposer matching Owner' -Tag 'NearMiss','OwnerMismatch' {
        $c = New-Record -Id 'contract/x' -Kind 'Contract' -Scalars @{ Owner = 'unit/command/a'; Status = 'active' }
        $a = New-Record -Id 'unit/command/a' -Scalars @{ Status = 'active' } -Lists @{ Exposes = @('contract/x') }
        $findings = Test-OwnerMismatch -Records @($c, $a)
        $findings.Count | Should -Be 0
    }

    It 'S5.1: EnforcementUnevidenced fires for an invariant claiming code enforcement with no Evidence' -Tag 'Fires','EnforcementUnevidenced' {
        $i = New-Record -Id 'I1' -Kind 'Invariant' -Scalars @{ Enforcement = 'code' } -Lists @{ Evidence = @() }
        $findings = Test-EnforcementUnevidenced -Records @($i)
        $findings.Count | Should -Be 1
    }

    It 'EnforcementUnevidenced does not fire when Evidence is present, or when Enforcement is instruction' -Tag 'NearMiss','EnforcementUnevidenced' {
        $withEvidence = New-Record -Id 'I1' -Kind 'Invariant' -Scalars @{ Enforcement = 'code' } -Lists @{ Evidence = @('tools/x.Tests.ps1') }
        $instruction = New-Record -Id 'I2' -Kind 'Invariant' -Scalars @{ Enforcement = 'instruction' } -Lists @{ Evidence = @() }
        $findings = Test-EnforcementUnevidenced -Records @($withEvidence, $instruction)
        $findings.Count | Should -Be 0
    }

    It 'S18.1: EnforcementUnevidenced fires for a superseded decision with no SupersededBy' -Tag 'Fires','EnforcementUnevidenced' {
        $d = New-Record -Id 'decision/x' -Kind 'Decision' -Scalars @{ Status = 'superseded' }
        $findings = Test-EnforcementUnevidenced -Records @($d)
        $findings.Count | Should -Be 1
        $findings[0].Detail | Should -Match "SupersededBy"
    }

    It 'S18.3: EnforcementUnevidenced does not fire for an accepted decision with no SupersededBy' -Tag 'NearMiss','EnforcementUnevidenced' {
        $d = New-Record -Id 'decision/x' -Kind 'Decision' -Scalars @{ Status = 'accepted' }
        $findings = Test-EnforcementUnevidenced -Records @($d)
        $findings.Count | Should -Be 0
    }

    It 'S18.1: EnforcementUnevidenced fires for an answered question with no AnsweredBy' -Tag 'Fires','EnforcementUnevidenced' {
        $q = New-Record -Id 'question/x' -Kind 'Question' -Scalars @{ Status = 'answered' }
        $findings = Test-EnforcementUnevidenced -Records @($q)
        $findings.Count | Should -Be 1
        $findings[0].Detail | Should -Match "AnsweredBy"
    }

    It 'S18.3: EnforcementUnevidenced does not fire for an open question with no AnsweredBy' -Tag 'NearMiss','EnforcementUnevidenced' {
        $q = New-Record -Id 'question/x' -Kind 'Question' -Scalars @{ Status = 'open' }
        $findings = Test-EnforcementUnevidenced -Records @($q)
        $findings.Count | Should -Be 0
    }
}

Describe 'Test-DesignState: IdCollision' {

    It 'S5.1: fires when two records claim the same id' -Tag 'Fires','IdCollision' {
        # a-again.md's own path implies id 'unit/command/a-again', which also disagrees with
        # the record's declared id - that is a second, independent IdCollision (a record whose
        # id disagrees with its file path), so both records claiming 'unit/command/a' produce
        # two findings here, not one.
        $a = New-Record -Id 'unit/command/a' -Path 'design/state/units/command/a.md'
        $b = New-Record -Id 'unit/command/a' -Path 'design/state/units/command/a-again.md'
        $findings = Test-RecordIdCollision -Records @($a, $b)
        (@($findings | Where-Object { $_.Detail -match 'claimed by more than one file' })).Count | Should -Be 1
    }

    It 'S4.7: fires when a record''s own id disagrees with the id its file path implies' -Tag 'Fires','IdCollision' {
        $a = New-Record -Id 'unit/command/wrong' -Path 'design/state/units/command/right.md'
        $findings = Test-RecordIdCollision -Records @($a)
        $findings.Count | Should -Be 1
        $findings[0].Detail | Should -Match 'right'
    }

    It 'does not fire when a single record''s id agrees with its path' -Tag 'NearMiss','IdCollision' {
        $a = New-Record -Id 'unit/command/right' -Path 'design/state/units/command/right.md'
        $findings = Test-RecordIdCollision -Records @($a)
        $findings.Count | Should -Be 0
    }

    It 'region form collision: fires when an id appears as both the projected and the declared form' -Tag 'Fires','IdCollision' {
        $inventory = @(
            [pscustomobject]@{ Id = 'companion'; Form = 'Projected'; File = 'a.md' }
            [pscustomobject]@{ Id = 'companion'; Form = 'Declared'; File = 'b.md' }
        )
        $findings = Test-RegionFormCollision -Inventory $inventory
        $findings.Count | Should -Be 1
        $findings[0].Class | Should -Be 'IdCollision'
    }

    It 'region form collision: does not fire when the same id only ever appears in one form' -Tag 'NearMiss','IdCollision' {
        $inventory = @(
            [pscustomobject]@{ Id = 'companion'; Form = 'Projected'; File = 'a.md' }
            [pscustomobject]@{ Id = 'companion'; Form = 'Projected'; File = 'b.md' }
        )
        $findings = Test-RegionFormCollision -Inventory $inventory
        $findings.Count | Should -Be 0
    }
}

Describe 'Test-DesignState: marked regions (RegionMalformed)' {

    It 'balanced projected and declared regions raise nothing' -Tag 'NearMiss','RegionMalformed' {
        New-TreeFile -RelativePath '.claude/commands/ok.md' -Content @'
before
<!-- companion:start -->
body
<!-- companion:end -->
<!-- extra:declared:start -->
hand-written
<!-- extra:declared:end -->
after
'@
        $result = Get-MarkedRegions -RepoPath $TestDrive -Files @('.claude/commands/ok.md')
        $result.Findings.Count | Should -Be 0
        $result.Inventory.Count | Should -Be 2
    }

    It 'S5.1: an unterminated region is RegionMalformed' -Tag 'Fires','RegionMalformed' {
        New-TreeFile -RelativePath '.claude/commands/unterminated.md' -Content @'
<!-- companion:start -->
never closed
'@
        $result = Get-MarkedRegions -RepoPath $TestDrive -Files @('.claude/commands/unterminated.md')
        $result.Findings.Count | Should -Be 1
        $result.Findings[0].Class | Should -Be 'RegionMalformed'
    }

    It 'S5.1: a nested region of the same id is RegionMalformed' -Tag 'Fires','RegionMalformed' {
        New-TreeFile -RelativePath '.claude/commands/nested.md' -Content @'
<!-- x:start -->
<!-- x:start -->
<!-- x:end -->
<!-- x:end -->
'@
        $result = Get-MarkedRegions -RepoPath $TestDrive -Files @('.claude/commands/nested.md')
        $result.Findings.Count | Should -BeGreaterThan 0
    }

    It 'a marker mentioned mid-sentence in prose (not alone on its line) is not treated as a region' -Tag 'NearMiss','RegionMalformed' {
        New-TreeFile -RelativePath 'design/prose.md' -Content @'
This paragraph mentions `<!-- agent:start -->` as an example of the syntax, inline.
'@
        $result = Get-MarkedRegions -RepoPath $TestDrive -Files @('design/prose.md')
        $result.Findings.Count | Should -Be 0
        $result.Inventory.Count | Should -Be 0
    }

    It 'a mismatched closing marker is RegionMalformed' -Tag 'Fires','RegionMalformed' {
        New-TreeFile -RelativePath '.claude/commands/mismatch.md' -Content @'
<!-- a:start -->
<!-- b:end -->
'@
        $result = Get-MarkedRegions -RepoPath $TestDrive -Files @('.claude/commands/mismatch.md')
        $result.Findings.Count | Should -BeGreaterThan 0
    }
}

Describe 'Test-DesignState: DecisionAnchorAmbiguous and LogEntryUnrecorded' {

    It 'S5.1: DecisionAnchorAmbiguous fires when a decision''s Anchor resolves to zero headings' -Tag 'Fires','DecisionAnchorAmbiguous' {
        New-TreeFile -RelativePath 'design/90-decisions.md' -Content @'
### 2026-01-01 — Something happened
'@
        $d = New-Record -Id 'decision/x' -Kind 'Decision' -Scalars @{ Anchor = '2026-01-01 — Something else entirely' }
        $findings = Test-DecisionAnchors -Records @($d) -LogPath (Join-Path $TestDrive 'design/90-decisions.md')
        (@($findings | Where-Object { $_.Class -eq 'DecisionAnchorAmbiguous' })).Count | Should -Be 1
    }

    It 'DecisionAnchorAmbiguous fires when a decision''s Anchor resolves to two headings' -Tag 'Fires','DecisionAnchorAmbiguous' {
        New-TreeFile -RelativePath 'design/90-decisions.md' -Content @'
### 2026-01-01 — Duplicate heading
### 2026-01-01 — Duplicate heading
'@
        $d = New-Record -Id 'decision/x' -Kind 'Decision' -Scalars @{ Anchor = '2026-01-01 — Duplicate heading' }
        $findings = Test-DecisionAnchors -Records @($d) -LogPath (Join-Path $TestDrive 'design/90-decisions.md')
        (@($findings | Where-Object { $_.Class -eq 'DecisionAnchorAmbiguous' })).Count | Should -Be 1
    }

    It 'DecisionAnchorAmbiguous does not fire when the Anchor resolves to exactly one heading' -Tag 'NearMiss','DecisionAnchorAmbiguous' {
        New-TreeFile -RelativePath 'design/90-decisions.md' -Content @'
### 2026-01-01 — Only one
'@
        $d = New-Record -Id 'decision/x' -Kind 'Decision' -Scalars @{ Anchor = '2026-01-01 — Only one' }
        $findings = Test-DecisionAnchors -Records @($d) -LogPath (Join-Path $TestDrive 'design/90-decisions.md')
        (@($findings | Where-Object { $_.Class -eq 'DecisionAnchorAmbiguous' })).Count | Should -Be 0
    }

    It 'S5.1: LogEntryUnrecorded fires for a log heading with no decision record naming it' -Tag 'Fires','LogEntryUnrecorded' {
        New-TreeFile -RelativePath 'design/90-decisions.md' -Content @'
### 2026-01-01 — Unrecorded entry
'@
        $findings = Test-DecisionAnchors -Records @() -LogPath (Join-Path $TestDrive 'design/90-decisions.md')
        (@($findings | Where-Object { $_.Class -eq 'LogEntryUnrecorded' })).Count | Should -Be 1
    }

    It 'LogEntryUnrecorded does not fire when every heading has a matching decision record' -Tag 'NearMiss','LogEntryUnrecorded' {
        New-TreeFile -RelativePath 'design/90-decisions.md' -Content @'
### 2026-01-01 — Recorded
'@
        $d = New-Record -Id 'decision/x' -Kind 'Decision' -Scalars @{ Anchor = '2026-01-01 — Recorded' }
        $findings = Test-DecisionAnchors -Records @($d) -LogPath (Join-Path $TestDrive 'design/90-decisions.md')
        (@($findings | Where-Object { $_.Class -eq 'LogEntryUnrecorded' })).Count | Should -Be 0
    }
}

Describe 'Test-DesignState: UnrecordedArtifact' {

    It 'fires for a command-glob file with no active unit record naming it as Anchor' -Tag 'Fires','UnrecordedArtifact' {
        New-TreeFile -RelativePath '.claude/commands/lonely.md' -Content 'x'
        $findings = Test-UnrecordedArtifact -Records @() -RepoPath $TestDrive
        (@($findings | Where-Object { $_.Subject -eq '.claude/commands/lonely.md' })).Count | Should -Be 1
    }

    It 'excludes a *-local.md companion file from the command glob' -Tag 'NearMiss','UnrecordedArtifact' {
        New-TreeFile -RelativePath '.claude/commands/foo-local.md' -Content 'x'
        $findings = Test-UnrecordedArtifact -Records @() -RepoPath $TestDrive
        (@($findings | Where-Object { $_.Subject -eq '.claude/commands/foo-local.md' })).Count | Should -Be 0
    }

    It 'does not fire when an active unit record names the artifact as its Anchor' -Tag 'NearMiss','UnrecordedArtifact' {
        New-TreeFile -RelativePath '.claude/commands/known.md' -Content 'x'
        $unit = New-Record -Id 'unit/command/known' -Scalars @{ Status = 'active'; Kind = 'command'; Anchor = '.claude/commands/known.md' }
        $findings = Test-UnrecordedArtifact -Records @($unit) -RepoPath $TestDrive
        (@($findings | Where-Object { $_.Subject -eq '.claude/commands/known.md' })).Count | Should -Be 0
    }

    It 'reverse direction: fires when an active unit record''s Anchor is not matched by its kind''s glob' -Tag 'Fires','UnrecordedArtifact' {
        $unit = New-Record -Id 'unit/command/ghost' -Scalars @{ Status = 'active'; Kind = 'command'; Anchor = '.claude/commands/does-not-exist.md' }
        $findings = Test-UnrecordedArtifact -Records @($unit) -RepoPath $TestDrive
        (@($findings | Where-Object { $_.Subject -eq 'unit/command/ghost' })).Count | Should -Be 1
    }

    It 'invariant kind: fires for a contract row with no record, and for a record that is no row' -Tag 'Fires','UnrecordedArtifact' {
        $recorded = New-Record -Id 'I8' -Kind 'Invariant' -Scalars @{ Status = 'active' }
        $findings = Test-UnrecordedArtifact -Records @($recorded) -RepoPath $TestDrive -InvariantIds @('I7')

        $subjects = @($findings | ForEach-Object { $_.Subject })
        $subjects | Should -Contain 'I7'
        $subjects | Should -Contain 'I8'
    }

    It 'invariant kind: raises nothing when the contract table and the records agree' -Tag 'NearMiss','UnrecordedArtifact' {
        $recorded = New-Record -Id 'I7' -Kind 'Invariant' -Scalars @{ Status = 'active' }
        $findings = Test-UnrecordedArtifact -Records @($recorded) -RepoPath $TestDrive -InvariantIds @('I7')
        (@($findings | Where-Object { $_.Subject -eq 'I7' })).Count | Should -Be 0
    }

    It 'invariant kind: a citation nothing records is not a finding - membership is the table, not the quote' -Tag 'NearMiss','UnrecordedArtifact' {
        New-TreeFile -RelativePath 'AGENTS.md' -Content 'This project relies on I7 throughout.'
        $findings = Test-UnrecordedArtifact -Records @() -RepoPath $TestDrive -InvariantIds @()
        (@($findings | Where-Object { $_.Subject -eq 'I7' })).Count | Should -Be 0
    }

    It 'invariant kind: an unreadable table leaves the half uncomputed rather than clean' -Tag 'NearMiss','UnrecordedArtifact' {
        $recorded = New-Record -Id 'I8' -Kind 'Invariant' -Scalars @{ Status = 'active' }
        $findings = Test-UnrecordedArtifact -Records @($recorded) -RepoPath $TestDrive -InvariantIds $null
        (@($findings | Where-Object { $_.Subject -eq 'I8' })).Count | Should -Be 0
    }
}

Describe 'Test-DesignState: Get-ContractInvariantIds' {

    It 'reads every invariant row of the Invariants section and stops at the next section' {
        $path = New-TreeFile -RelativePath 'design/20-contract.md' -Content @'
# Contract

## Invariants

<!-- invariants:start -->
| | Statement | Owner | Enforcement | Evidence |
|---|---|---|---|---|
| **I3** | x | y | instruction | - |
<!-- invariants:end -->

| | Statement | Owner | Enforcement | Evidence |
|---|---|---|---|---|
| **I1** | x | y | code | z |
| **I2** | x | y | code | z |

## Unresolved

| **I99** | not an invariant row - it is past the section |
'@
        $parsed = Get-ContractInvariantIds -ContractPath $path
        $parsed.Failure | Should -BeNullOrEmpty
        $parsed.Ids | Should -Be @('I1', 'I2', 'I3')
    }

    It 'reports ContractPathMissing rather than an empty set when the document is absent' {
        $parsed = Get-ContractInvariantIds -ContractPath (Join-Path $TestDrive 'design/absent.md')
        $parsed.Ids | Should -BeNullOrEmpty
        $parsed.Failure | Should -Be 'ContractPathMissing'
    }

    It 'reports InvariantsSectionNotFound rather than an empty set when the section is absent' {
        $path = New-TreeFile -RelativePath 'design/no-invariants.md' -Content "# Contract`n`n## Types`n`nnothing here`n"
        $parsed = Get-ContractInvariantIds -ContractPath $path
        $parsed.Ids | Should -BeNullOrEmpty
        $parsed.Failure | Should -Be 'InvariantsSectionNotFound'
    }
}

Describe 'Test-DesignState: the budget meter (S5.5, S5.7)' {

    It 'S5.5: a live record naming a retired one raises no UnresolvedId finding' {
        New-StateFile -RelativePath 'units/command/root.md' -Content @'
# unit/command/root
Kind: command
Live: decision/retired-one
'@
        New-StateFile -RelativePath 'decisions/retired-one.md' -Content @'
# decision/retired-one
Status: retired
'@
        $graph = Read-DesignStateGraph -Path $TestDrive
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        $findings = Test-UnresolvedId -ById $byId -Records $graph.Records
        $findings.Count | Should -Be 0
    }

    It 'S5.7: ClosureOverBudget fires at 16,385 bytes' -Tag 'Fires','ClosureOverBudget' {
        $overPath = New-ExactSizeRecord -Slug 'big-over' -TotalBytes 16385
        (Get-Item $overPath).Length | Should -Be 16385

        $graph = Read-DesignStateGraph -Path $TestDrive
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }

        $result = Test-ClosureBudget -Records $graph.Records -ById $byId -RepoPath $TestDrive
        (@($result.Findings | Where-Object { $_.Subject -eq 'unit/command/big-over' })).Count | Should -Be 1
    }

    It 'S5.7: ClosureOverBudget does not fire at exactly 16,384 bytes - the ceiling is inclusive' -Tag 'NearMiss','ClosureOverBudget' {
        $underPath = New-ExactSizeRecord -Slug 'big-under' -TotalBytes 16384
        (Get-Item $underPath).Length | Should -Be 16384

        $graph = Read-DesignStateGraph -Path $TestDrive
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }

        $result = Test-ClosureBudget -Records $graph.Records -ById $byId -RepoPath $TestDrive
        (@($result.Findings | Where-Object { $_.Subject -eq 'unit/command/big-under' })).Count | Should -Be 0
    }

    It 'S5.6: names the largest closure, its unit, and its largest contributor' {
        New-StateFile -RelativePath 'units/command/small.md' -Content @'
# unit/command/small
Kind: command
'@
        $graph = Read-DesignStateGraph -Path $TestDrive
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        $result = Test-ClosureBudget -Records $graph.Records -ById $byId -RepoPath $TestDrive

        $result.Largest | Should -Not -BeNullOrEmpty
        $result.Largest.Unit | Should -Not -BeNullOrEmpty
        $result.Largest.Bytes | Should -BeGreaterThan 0
        $result.Largest.LargestContributor | Should -Not -BeNullOrEmpty
    }
}

Describe 'Test-DesignState: the records-bounded closure (S23)' {

    It 'S23.1: a Unit root whose Anchor is a tree path returns the same member set as the same root with the Anchor removed, and no member carries Kind = Artifact' {
        New-StateFile -RelativePath 'units/document/s23-with-anchor.md' -Content @'
# unit/document/s23-with-anchor
Kind: document
Status: active
Anchor: s23-artifact.md
'@
        New-TreeFile -RelativePath 's23-artifact.md' -Content ('a' * 250)
        $graph = Read-DesignStateGraph -Path $TestDrive
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        $root = $byId['unit/document/s23-with-anchor']

        $members = Get-DesignClosure -Root $root -ById $byId
        @($members | Where-Object { $_.Kind -eq 'Artifact' }).Count | Should -Be 0

        $withoutAnchor = New-DesignRecord -Id $root.Id -Kind $root.Kind -Path $root.Path `
            -Scalars ($root.Scalars.Clone()) -Lists $root.Lists -Prose $root.Prose
        $withoutAnchor.Scalars.Remove('Anchor')
        $membersWithoutAnchor = Get-DesignClosure -Root $withoutAnchor -ById $byId

        @($members | ForEach-Object { $_.Id }) | Should -Be @($membersWithoutAnchor | ForEach-Object { $_.Id })
    }

    It 'S23.1: a root with no Anchor counts records only' {
        New-StateFile -RelativePath 'units/command/s23-no-anchor.md' -Content @'
# unit/command/s23-no-anchor
Kind: command
Status: active
'@
        $graph = Read-DesignStateGraph -Path $TestDrive
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        $root = $byId['unit/command/s23-no-anchor']

        $members = Get-DesignClosure -Root $root -ById $byId
        @($members | Where-Object { $_.Kind -eq 'Artifact' }).Count | Should -Be 0
    }

    It 'S23.1: an Invariant root, whose Anchor is the invariant number rather than a path, counts records only' {
        New-StateFile -RelativePath 'invariants/I900.md' -Content @'
# I900
Kind: invariant
Status: active
Anchor: I900
Owner: unit/command/s23-no-anchor
Enforcement: instruction
'@
        $graph = Read-DesignStateGraph -Path $TestDrive
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        $root = $byId['I900']

        $members = Get-DesignClosure -Root $root -ById $byId
        @($members | Where-Object { $_.Kind -eq 'Artifact' }).Count | Should -Be 0
    }

    It 'S23.2: the unit''s own artifact is measured separately, by the byte length of the file its Anchor names, and is never a closure member' {
        New-StateFile -RelativePath 'units/document/s23-dominant-artifact.md' -Content @'
# unit/document/s23-dominant-artifact
Kind: document
Status: active
Anchor: s23-big-artifact.md
'@
        $artifactPath = New-TreeFile -RelativePath 's23-big-artifact.md' -Content ('b' * 20000)
        $artifactBytes = (Get-Item -LiteralPath $artifactPath).Length
        $graph = Read-DesignStateGraph -Path $TestDrive
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        $root = $byId['unit/document/s23-dominant-artifact']

        Get-UnitArtifactBytes -RepoPath $TestDrive -Root $root | Should -Be $artifactBytes

        $result = Test-ClosureBudget -Records $graph.Records -ById $byId -RepoPath $TestDrive
        $finding = @($result.Findings | Where-Object { $_.Subject -eq 'unit/document/s23-dominant-artifact' })
        # The 20,000-byte artifact is excluded from the bound (S23.1), so the record-only
        # closure - the record itself, well under the ceiling - does not breach.
        $finding.Count | Should -Be 0
    }

    It 'S23.4: LargestContributor names a record by id, never the artifact - the closure has no artifact member to name' {
        New-StateFile -RelativePath 'units/document/s23-record-dominant.md' -Content @'
# unit/document/s23-record-dominant
Kind: document
Status: active
Anchor: s23-tiny-artifact.md
Live: decision/s23-record-dominant-live
'@
        $tinyArtifactPath = New-TreeFile -RelativePath 's23-tiny-artifact.md' -Content 'x'
        $tinyArtifactBytes = (Get-Item -LiteralPath $tinyArtifactPath).Length
        New-StateFile -RelativePath 'decisions/s23-record-dominant-live.md' -Content @"
# decision/s23-record-dominant-live
Status: accepted

## Claim
$('y' * 500)
"@
        $graph = Read-DesignStateGraph -Path $TestDrive
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        $root = $byId['unit/document/s23-record-dominant']

        $members = Get-DesignClosure -Root $root -ById $byId
        $sized = @($members | ForEach-Object { [pscustomobject]@{ Record = $_; Bytes = (Get-RecordFileBytes -RepoPath $TestDrive -Record $_) } })
        $biggest = $sized | Sort-Object Bytes -Descending | Select-Object -First 1
        $biggest.Record.Id | Should -Be 'decision/s23-record-dominant-live'

        $result = Test-ClosureBudget -Records $graph.Records -ById $byId -RepoPath $TestDrive
        $result.Largest.LargestContributor | Should -Be 'decision/s23-record-dominant-live'
        $result.Largest.ArtifactBytes | Should -Be $tinyArtifactBytes
    }

    It 'S23.2: a Unit root whose Anchor names a path not in the tree yields zero artifact bytes rather than throwing, and raises no closure finding for it' {
        New-StateFile -RelativePath 'units/document/s23-missing-anchor.md' -Content @'
# unit/document/s23-missing-anchor
Kind: document
Status: active
Anchor: s23-does-not-exist.md
'@
        $graph = Read-DesignStateGraph -Path $TestDrive
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        $root = $byId['unit/document/s23-missing-anchor']

        { Get-UnitArtifactBytes -RepoPath $TestDrive -Root $root } | Should -Not -Throw
        Get-UnitArtifactBytes -RepoPath $TestDrive -Root $root | Should -Be 0

        { Test-ClosureBudget -Records $graph.Records -ById $byId -RepoPath $TestDrive } | Should -Not -Throw
        $result = Test-ClosureBudget -Records $graph.Records -ById $byId -RepoPath $TestDrive
        (@($result.Findings | Where-Object { $_.Subject -eq 'unit/document/s23-missing-anchor' })).Count | Should -Be 0
    }

    It 'S23.3: a ClosureOverBudget finding''s detail carries the unit''s own artifact size, named separately and never added into the bounded figure' {
        $overPath = New-ExactSizeRecord -Slug 's23-over' -TotalBytes 16385
        (Get-Item $overPath).Length | Should -Be 16385

        $graph = Read-DesignStateGraph -Path $TestDrive
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        $result = Test-ClosureBudget -Records $graph.Records -ById $byId -RepoPath $TestDrive

        $finding = @($result.Findings | Where-Object { $_.Subject -eq 'unit/command/s23-over' })
        $finding.Count | Should -Be 1
        $finding[0].Detail | Should -Match "closure is 16385 bytes"
        $finding[0].Detail | Should -Match "artifact is 0 bytes"
    }

    It 'S23.5: Largest always carries the unit, its largest contributor, and that unit''s own artifact size, whether or not any closure breaches' {
        New-StateFile -RelativePath 'units/command/s23-clean.md' -Content @'
# unit/command/s23-clean
Kind: command
Status: active
'@
        $graph = Read-DesignStateGraph -Path $TestDrive
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        $result = Test-ClosureBudget -Records $graph.Records -ById $byId -RepoPath $TestDrive

        $result.Largest | Should -Not -BeNullOrEmpty
        $result.Largest.Unit | Should -Not -BeNullOrEmpty
        $result.Largest.LargestContributor | Should -Not -BeNullOrEmpty
        $result.Largest.ArtifactBytes | Should -Not -BeNullOrEmpty
    }
}

Describe 'Test-DesignState: the retired-companion split (S20)' {

    BeforeEach {
        Get-ChildItem $TestDrive -ErrorAction SilentlyContinue -Recurse -File |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }

    It 'S20.1: a companion joins into the active record as one record, and FieldOrigin names each field''s source file' {
        New-StateFile -RelativePath 'units/command/paired.md' -Content @'
# unit/command/paired
Kind: command
Status: active
Live: decision/paired-live
'@
        New-StateFile -RelativePath 'units/command/retired/paired.md' -Content @'
Archival: decision/paired-archival
'@
        $graph = Read-DesignStateGraph -Path $TestDrive

        $matches = @($graph.Records | Where-Object { $_.Id -eq 'unit/command/paired' })
        $matches.Count | Should -Be 1 -Because 'the reader emits one record per unit and never two'
        $r = $matches[0]
        $r.CompanionPath | Should -Be 'design/state/units/command/retired/paired.md'
        $r.Lists['Live'] | Should -Be @('decision/paired-live')
        $r.Lists['Archival'] | Should -Be @('decision/paired-archival')
        $r.FieldOrigin['Live'] | Should -Be 'Active'
        $r.FieldOrigin['Archival'] | Should -Be 'Companion'
    }

    It 'S20.2: a unit with no companion file parses as a unit whose every retired half is empty - not a missing file, not a finding' {
        New-StateFile -RelativePath 'units/command/solo.md' -Content @'
# unit/command/solo
Kind: command
Status: active
'@
        $graph = Read-DesignStateGraph -Path $TestDrive

        $graph.CompanionOnly.Count | Should -Be 0
        $r = @($graph.Records | Where-Object { $_.Id -eq 'unit/command/solo' })[0]
        $r.CompanionPath | Should -BeNullOrEmpty
        $r.Lists.ContainsKey('Archival') | Should -BeFalse

        $findings = Test-RecordPairMalformed -Records @($r) -CompanionOnly $graph.CompanionOnly
        $findings.Count | Should -Be 0
    }

    It 'S20.3: a companion path resolves its kind segment against the four unit kinds' {
        $info = Get-DesignPathInfo -RelativeToState 'units/command/retired/x.md'
        $info.PathId | Should -Be 'unit/command/x'
        $info.IsCompanion | Should -BeTrue
    }

    It 'S20.3: a path naming "retired" where the kind belongs is a parse failure - retired never resolves as a kind' {
        Get-DesignPathInfo -RelativeToState 'units/retired/x.md' | Should -BeNullOrEmpty
    }

    It 'S20.4: RecordPairMalformed fires for a companion with no active record beside it' -Tag 'Fires', 'RecordPairMalformed' {
        New-StateFile -RelativePath 'units/command/retired/orphan.md' -Content @'
Archival: decision/x
'@
        $graph = Read-DesignStateGraph -Path $TestDrive
        $findings = Test-RecordPairMalformed -Records $graph.Records -CompanionOnly $graph.CompanionOnly
        $findings.Count | Should -Be 1
        $findings[0].Subject | Should -Be 'unit/command/orphan'
    }

    It 'S20.4: RecordPairMalformed fires when a retired-half field is written into the active record' -Tag 'Fires', 'RecordPairMalformed' {
        New-StateFile -RelativePath 'units/command/misfiled.md' -Content @'
# unit/command/misfiled
Kind: command
Status: active
Archival: decision/x
'@
        $graph = Read-DesignStateGraph -Path $TestDrive
        $findings = Test-RecordPairMalformed -Records $graph.Records -CompanionOnly $graph.CompanionOnly
        $findings.Count | Should -Be 1
        $findings[0].Subject | Should -Be 'unit/command/misfiled'
        $findings[0].Detail | Should -Match "field 'Archival' belongs in the retired companion"
        $findings[0].Detail | Should -Match 'active='
        $findings[0].Detail | Should -Match 'companion='
    }

    It 'S20.4: RecordPairMalformed fires when an active-half field is written into the companion' -Tag 'Fires', 'RecordPairMalformed' {
        New-StateFile -RelativePath 'units/command/misfiled2.md' -Content @'
# unit/command/misfiled2
Kind: command
Status: active
'@
        New-StateFile -RelativePath 'units/command/retired/misfiled2.md' -Content @'
Live: decision/x
'@
        $graph = Read-DesignStateGraph -Path $TestDrive
        $findings = Test-RecordPairMalformed -Records $graph.Records -CompanionOnly $graph.CompanionOnly
        $findings.Count | Should -Be 1
        $findings[0].Subject | Should -Be 'unit/command/misfiled2'
        $findings[0].Detail | Should -Match "field 'Live' belongs in the active record"
    }

    It 'S20.4: a unit with an empty companion, and a unit with none, are both silent' -Tag 'NearMiss', 'RecordPairMalformed' {
        New-StateFile -RelativePath 'units/command/empty-companion.md' -Content @'
# unit/command/empty-companion
Kind: command
Status: active
'@
        New-StateFile -RelativePath 'units/command/retired/empty-companion.md' -Content "`n"
        New-StateFile -RelativePath 'units/command/no-companion.md' -Content @'
# unit/command/no-companion
Kind: command
Status: active
'@
        $graph = Read-DesignStateGraph -Path $TestDrive
        $findings = Test-RecordPairMalformed -Records $graph.Records -CompanionOnly $graph.CompanionOnly
        $findings.Count | Should -Be 0
    }

    It 'S20.5: HalfStatusMismatch fires when an active edge names a referent whose status the edge forbids' -Tag 'Fires', 'HalfStatusMismatch' {
        $live = New-Record -Id 'unit/command/bad-live' -Scalars @{ Status = 'active' } -Lists @{ Live = @('decision/superseded-one') }
        $decision = New-Record -Id 'decision/superseded-one' -Kind 'Decision' -Scalars @{ Status = 'superseded' }
        $byId = @{ 'unit/command/bad-live' = $live; 'decision/superseded-one' = $decision }
        $findings = Test-HalfStatusMismatch -Records @($live, $decision) -ById $byId
        $findings.Count | Should -Be 1
        $findings[0].Subject | Should -Be 'unit/command/bad-live'
    }

    It 'S20.5: HalfStatusMismatch fires when a retired half names a referent whose status the half forbids' -Tag 'Fires', 'HalfStatusMismatch' {
        $unit = New-Record -Id 'unit/command/bad-archival' -Scalars @{ Status = 'active' } -Lists @{ Archival = @('decision/still-live') }
        $decision = New-Record -Id 'decision/still-live' -Kind 'Decision' -Scalars @{ Status = 'accepted' }
        $byId = @{ 'unit/command/bad-archival' = $unit; 'decision/still-live' = $decision }
        $findings = Test-HalfStatusMismatch -Records @($unit, $decision) -ById $byId
        $findings.Count | Should -Be 1
        $findings[0].Subject | Should -Be 'unit/command/bad-archival'
    }

    It 'S20.5: HalfStatusMismatch also checks Work/Worked against a WorkRef''s State, in both directions' -Tag 'Fires', 'HalfStatusMismatch' {
        $unit = New-Record -Id 'unit/command/bad-work' -Scalars @{ Status = 'active' } -Lists @{ Work = @('999') }
        $work = New-Record -Id 'work/999' -Kind 'WorkRef' -Scalars @{ Issue = '999'; State = 'CLOSED' }
        $byId = @{ 'unit/command/bad-work' = $unit; 'work/999' = $work }
        $findings = Test-HalfStatusMismatch -Records @($unit, $work) -ById $byId
        $findings.Count | Should -Be 1
        $findings[0].Detail | Should -Match 'Work'
    }

    It 'S20.5: an active edge naming an active/open referent, and a retired half naming a retired/superseded/answered/closed one, are silent' -Tag 'NearMiss', 'HalfStatusMismatch' {
        $unit = New-Record -Id 'unit/command/good-pair' -Scalars @{ Status = 'active' } -Lists @{
            Live = @('decision/good-live'); Archival = @('decision/good-archival')
            Questions = @('question/good-open'); Answered = @('question/good-answered')
            Work = @('1'); Worked = @('2')
        }
        $goodLive = New-Record -Id 'decision/good-live' -Kind 'Decision' -Scalars @{ Status = 'accepted' }
        $goodArchival = New-Record -Id 'decision/good-archival' -Kind 'Decision' -Scalars @{ Status = 'superseded' }
        $goodOpen = New-Record -Id 'question/good-open' -Kind 'Question' -Scalars @{ Status = 'open' }
        $goodAnswered = New-Record -Id 'question/good-answered' -Kind 'Question' -Scalars @{ Status = 'answered' }
        $workOpen = New-Record -Id 'work/1' -Kind 'WorkRef' -Scalars @{ Issue = '1'; State = 'OPEN' }
        $workClosed = New-Record -Id 'work/2' -Kind 'WorkRef' -Scalars @{ Issue = '2'; State = 'CLOSED' }
        $records = @($unit, $goodLive, $goodArchival, $goodOpen, $goodAnswered, $workOpen, $workClosed)
        $byId = @{}
        foreach ($r in $records) { $byId[$r.Id] = $r }

        $findings = Test-HalfStatusMismatch -Records $records -ById $byId
        $findings.Count | Should -Be 0
    }

    It 'S20.6: HalfOverlap fires when one id sits in both halves of one edge' -Tag 'Fires', 'HalfOverlap' {
        $unit = New-Record -Id 'unit/command/overlap' -Lists @{ Live = @('decision/x'); Archival = @('decision/x') }
        $findings = Test-HalfOverlap -Records @($unit)
        $findings.Count | Should -Be 1
        $findings[0].Subject | Should -Be 'unit/command/overlap'
        $findings[0].Detail | Should -Match 'decision/x'
    }

    It 'S20.6: the same id in two different edges is silent' -Tag 'NearMiss', 'HalfOverlap' {
        $unit = New-Record -Id 'unit/command/nooverlap' -Lists @{ Live = @('decision/x'); Binds = @('decision/x') }
        $findings = Test-HalfOverlap -Records @($unit)
        $findings.Count | Should -Be 0
    }

    It 'S20.8: Get-DesignClosure no longer skips a named record whose Status is retired' {
        New-StateFile -RelativePath 'units/command/root2.md' -Content @'
# unit/command/root2
Kind: command
Status: active
Live: decision/retired-target
'@
        New-StateFile -RelativePath 'decisions/retired-target.md' -Content @'
# decision/retired-target
Status: retired
'@
        $graph = Read-DesignStateGraph -Path $TestDrive
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        $root = $byId['unit/command/root2']

        $members = Get-DesignClosure -Root $root -ById $byId
        @($members | ForEach-Object { $_.Id }) | Should -Contain 'decision/retired-target'
    }

    It 'S20.8: the retired companion is never a closure member, and the closure size does not grow with it' {
        New-StateFile -RelativePath 'units/command/sized.md' -Content @'
# unit/command/sized
Kind: command
Status: active
'@
        New-StateFile -RelativePath 'units/command/retired/sized.md' -Content ("Archival:`n" + ('z' * 5000))
        $graph = Read-DesignStateGraph -Path $TestDrive
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        $root = $byId['unit/command/sized']

        $members = Get-DesignClosure -Root $root -ById $byId
        @($members | ForEach-Object { $_.Path }) | Should -Not -Contain 'design/state/units/command/retired/sized.md'

        $result = Test-ClosureBudget -Records $graph.Records -ById $byId -RepoPath $TestDrive
        (@($result.Findings | Where-Object { $_.Subject -eq 'unit/command/sized' })).Count | Should -Be 0
    }
}

Describe 'Test-DesignState: absorption sites (S21)' {

    BeforeEach {
        Get-ChildItem $TestDrive -ErrorAction SilentlyContinue -Recurse -File |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }

    It 'S21.2: SiteAmbiguous fires when a site resolves to zero headings' -Tag 'Fires', 'SiteAmbiguous' {
        New-TreeFile -RelativePath 'TARGET.md' -Content @'
# Title

## Something Else
'@
        $unit = New-Record -Id 'unit/document/target' -Scalars @{ Kind = 'document'; Status = 'active'; Anchor = 'TARGET.md' }
        $decision = New-Record -Id 'decision/zero-heading' -Kind 'Decision' -Scalars @{ Status = 'accepted' } -Lists @{ StatedIn = @('unit/document/target § Missing Heading') }
        $byId = @{ 'unit/document/target' = $unit; 'decision/zero-heading' = $decision }

        $findings = Test-SiteAmbiguous -Records @($unit, $decision) -ById $byId -RepoPath $TestDrive
        $findings.Count | Should -Be 1
        $findings[0].Subject | Should -Be 'decision/zero-heading'
        $findings[0].Detail | Should -Match '0 heading'
    }

    It 'S21.2: SiteAmbiguous fires when a site resolves to two headings' -Tag 'Fires', 'SiteAmbiguous' {
        New-TreeFile -RelativePath 'TARGET2.md' -Content @'
## Duplicate

## Duplicate
'@
        $unit = New-Record -Id 'unit/document/target2' -Scalars @{ Kind = 'document'; Status = 'active'; Anchor = 'TARGET2.md' }
        $decision = New-Record -Id 'decision/two-heading' -Kind 'Decision' -Scalars @{ Status = 'accepted' } -Lists @{ StatedIn = @('unit/document/target2 § Duplicate') }
        $byId = @{ 'unit/document/target2' = $unit; 'decision/two-heading' = $decision }

        $findings = Test-SiteAmbiguous -Records @($unit, $decision) -ById $byId -RepoPath $TestDrive
        $findings.Count | Should -Be 1
        $findings[0].Detail | Should -Match '2 heading'
    }

    It 'S21.2: a site resolving to exactly one heading is silent' -Tag 'NearMiss', 'SiteAmbiguous' {
        New-TreeFile -RelativePath 'TARGET3.md' -Content @'
## Exactly One
'@
        $unit = New-Record -Id 'unit/document/target3' -Scalars @{ Kind = 'document'; Status = 'active'; Anchor = 'TARGET3.md' }
        $decision = New-Record -Id 'decision/one-heading' -Kind 'Decision' -Scalars @{ Status = 'accepted' } -Lists @{ StatedIn = @('unit/document/target3 § Exactly One') }
        $byId = @{ 'unit/document/target3' = $unit; 'decision/one-heading' = $decision }

        $findings = Test-SiteAmbiguous -Records @($unit, $decision) -ById $byId -RepoPath $TestDrive
        $findings.Count | Should -Be 0
    }

    It 'S21.3: SiteOutOfReach fires when no unit''s own identity or one-hop closure names the site''s id' -Tag 'Fires', 'SiteOutOfReach' {
        $unit = New-Record -Id 'unit/document/unrelated' -Scalars @{ Status = 'active' }
        $decision = New-Record -Id 'decision/orphan-site' -Kind 'Decision' -Scalars @{ Status = 'accepted' } -Lists @{ StatedIn = @('unit/document/nowhere § Some Heading') }

        $findings = Test-SiteOutOfReach -Records @($unit, $decision)
        $findings.Count | Should -Be 1
        $findings[0].Subject | Should -Be 'decision/orphan-site'
    }

    It 'S21.3: a site naming a contract at least one unit consumes or exposes is silent' -Tag 'NearMiss', 'SiteOutOfReach' {
        $unit = New-Record -Id 'unit/script/holder' -Scalars @{ Status = 'active' } -Lists @{ Exposes = @('contract/held') }
        $decision = New-Record -Id 'decision/reachable-site' -Kind 'Decision' -Scalars @{ Status = 'accepted' } -Lists @{ StatedIn = @('contract/held § Semantics') }

        $findings = Test-SiteOutOfReach -Records @($unit, $decision)
        $findings.Count | Should -Be 0
    }

    It 'S21.4: SiteContradictsLive fires when a decision is both named by a unit''s Live and stated in that same unit' -Tag 'Fires', 'SiteContradictsLive' {
        $unit = New-Record -Id 'unit/document/both' -Scalars @{ Status = 'active' } -Lists @{ Live = @('decision/contradicts') }
        $decision = New-Record -Id 'decision/contradicts' -Kind 'Decision' -Scalars @{ Status = 'accepted' } -Lists @{ StatedIn = @('unit/document/both § Some Heading') }

        $findings = Test-SiteContradictsLive -Records @($unit, $decision)
        $findings.Count | Should -Be 1
        $findings[0].Subject | Should -Be 'unit/document/both'
    }

    It 'S21.4: a decision Live on one unit and stated in a different one is silent' -Tag 'NearMiss', 'SiteContradictsLive' {
        $liveUnit = New-Record -Id 'unit/document/holds-live' -Scalars @{ Status = 'active' } -Lists @{ Live = @('decision/elsewhere') }
        $siteUnit = New-Record -Id 'unit/document/holds-site' -Scalars @{ Status = 'active' }
        $decision = New-Record -Id 'decision/elsewhere' -Kind 'Decision' -Scalars @{ Status = 'accepted' } -Lists @{ StatedIn = @('unit/document/holds-site § Some Heading') }

        $findings = Test-SiteContradictsLive -Records @($liveUnit, $siteUnit, $decision)
        $findings.Count | Should -Be 0
    }
}

Describe 'Test-DesignState: DecisionUnplaced and SupersessionCycle (S22)' {

    It 'S22.3: DecisionUnplaced fires for an accepted decision named by no unit''s Live and placing no site' -Tag 'Fires', 'DecisionUnplaced' {
        $decision = New-Record -Id 'decision/orphan' -Kind 'Decision' -Scalars @{ Status = 'accepted' }
        $findings = Test-DecisionUnplaced -Records @($decision)
        $findings.Count | Should -Be 1
        $findings[0].Subject | Should -Be 'decision/orphan'
        $findings[0].Detail | Should -Match 'accepted'
    }

    It 'S22.3: DecisionUnplaced fires for a superseded decision named by no unit''s Archival' -Tag 'Fires', 'DecisionUnplaced' {
        $decision = New-Record -Id 'decision/lost' -Kind 'Decision' -Scalars @{ Status = 'superseded'; SupersededBy = 'decision/somewhere' }
        $findings = Test-DecisionUnplaced -Records @($decision)
        $findings.Count | Should -Be 1
        $findings[0].Detail | Should -Match 'superseded'
    }

    It 'S22.3: an accepted decision named by a unit''s Live is silent' -Tag 'NearMiss', 'DecisionUnplaced' {
        $unit = New-Record -Id 'unit/document/holder' -Scalars @{ Status = 'active' } -Lists @{ Live = @('decision/held') }
        $decision = New-Record -Id 'decision/held' -Kind 'Decision' -Scalars @{ Status = 'accepted' }
        $findings = Test-DecisionUnplaced -Records @($unit, $decision)
        $findings.Count | Should -Be 0
    }

    It 'S22.3: a decision placed by a site alone is silent - placement is presence, not resolution' -Tag 'NearMiss', 'DecisionUnplaced' {
        $decision = New-Record -Id 'decision/site-placed' -Kind 'Decision' -Scalars @{ Status = 'accepted' } -Lists @{ StatedIn = @('unit/document/nowhere § Missing Heading') }
        $findings = Test-DecisionUnplaced -Records @($decision)
        $findings.Count | Should -Be 0
    }

    It 'S22.3: a superseded decision named by a unit''s Archival is silent' -Tag 'NearMiss', 'DecisionUnplaced' {
        $unit = New-Record -Id 'unit/document/archiver' -Scalars @{ Status = 'active' } -Lists @{ Archival = @('decision/archived') }
        $decision = New-Record -Id 'decision/archived' -Kind 'Decision' -Scalars @{ Status = 'superseded'; SupersededBy = 'decision/elsewhere' }
        $findings = Test-DecisionUnplaced -Records @($unit, $decision)
        $findings.Count | Should -Be 0
    }

    It 'S22.6: SupersessionCycle fires on a two-record cycle, reporting it once regardless of which member the walk starts from' -Tag 'Fires', 'SupersessionCycle' {
        $a = New-Record -Id 'decision/cycle-a' -Kind 'Decision' -Scalars @{ Status = 'superseded'; SupersededBy = 'decision/cycle-b' }
        $b = New-Record -Id 'decision/cycle-b' -Kind 'Decision' -Scalars @{ Status = 'superseded'; SupersededBy = 'decision/cycle-a' }
        $byId = @{ 'decision/cycle-a' = $a; 'decision/cycle-b' = $b }
        $findings = Test-SupersessionCycle -Records @($a, $b) -ById $byId
        $findings.Count | Should -Be 1
        $findings[0].Detail | Should -Match 'decision/cycle-a'
        $findings[0].Detail | Should -Match 'decision/cycle-b'
    }

    It 'S22.6: SupersessionCycle fires when a decision names itself' -Tag 'Fires', 'SupersessionCycle' {
        $self = New-Record -Id 'decision/self-loop' -Kind 'Decision' -Scalars @{ Status = 'superseded'; SupersededBy = 'decision/self-loop' }
        $byId = @{ 'decision/self-loop' = $self }
        $findings = Test-SupersessionCycle -Records @($self) -ById $byId
        $findings.Count | Should -Be 1
        $findings[0].Subject | Should -Be 'decision/self-loop'
    }

    It 'S22.6: a terminating chain of three or more, ending in an accepted decision, is silent' -Tag 'NearMiss', 'SupersessionCycle' {
        $a = New-Record -Id 'decision/chain-a' -Kind 'Decision' -Scalars @{ Status = 'superseded'; SupersededBy = 'decision/chain-b' }
        $b = New-Record -Id 'decision/chain-b' -Kind 'Decision' -Scalars @{ Status = 'superseded'; SupersededBy = 'decision/chain-c' }
        $c = New-Record -Id 'decision/chain-c' -Kind 'Decision' -Scalars @{ Status = 'accepted' }
        $byId = @{ 'decision/chain-a' = $a; 'decision/chain-b' = $b; 'decision/chain-c' = $c }
        $findings = Test-SupersessionCycle -Records @($a, $b, $c) -ById $byId
        $findings.Count | Should -Be 0
    }
}

Describe 'Test-DesignState: LiveAlreadyStated (S30.1, S30.2)' {

    BeforeEach {
        Get-ChildItem $TestDrive -ErrorAction SilentlyContinue -Recurse -File |
            Remove-Item -Force -ErrorAction SilentlyContinue
        New-TreeFile -RelativePath 'design/20-contract.md' -Content $script:MinimalContract
        New-TreeFile -RelativePath 'design/90-decisions.md' -Content "# Decisions`n"
    }

    It 'S30.1: the checker declares LiveAlreadyStated in its reported class list' {
        $script:ReportedClasses | Should -Contain 'LiveAlreadyStated'
    }

    It 'S30.2: a run against a fixture unit whose Live decision''s Claim text stands verbatim under its own Anchor''s heading raises no LiveAlreadyStated finding - the checker never raises the id it declares' {
        New-TreeFile -RelativePath '.claude/commands/fixture.md' -Content @'
# Fixture

## Already Stated
The claim text stands here, verbatim.
'@
        New-StateFile -RelativePath 'units/command/fixture.md' -Content @'
# unit/command/fixture
Kind: command
Status: active
Anchor: .claude/commands/fixture.md
Live: decision/fixture-claim
'@
        New-StateFile -RelativePath 'decisions/fixture-claim.md' -Content @'
# decision/fixture-claim
Status: accepted

## Claim
The claim text stands here, verbatim.
'@
        $result = Invoke-DesignStateCheck -RepoPath $TestDrive

        (@($result.Findings | Where-Object { $_.Class -eq 'LiveAlreadyStated' })).Count | Should -Be 0
        (@($result.Reported | Where-Object { $_.Class -eq 'LiveAlreadyStated' })).Count | Should -Be 0
    }
}

Describe 'Test-DesignState: ClassListDisagreement (S5.1)' {

    It 'raises nothing when the contract document declares exactly the same 32 ids' -Tag 'NearMiss','ClassListDisagreement' {
        New-TreeFile -RelativePath 'design/20-contract.md' -Content $script:MinimalContract
        $result = Test-ClassListAgreement -ContractPath (Join-Path $TestDrive 'design/20-contract.md')
        $result.Finding | Should -BeNullOrEmpty
        $result.CouldNotEvaluate | Should -BeNullOrEmpty
    }

    It 'fires when the contract document is missing a blocking class the script declares' -Tag 'Fires','ClassListDisagreement' {
        $missingOne = $script:MinimalContract -replace "\| ``ClosureOverBudget`` \| x \| x \|\r?\n", ''
        New-TreeFile -RelativePath 'design/20-contract-missing.md' -Content $missingOne
        $result = Test-ClassListAgreement -ContractPath (Join-Path $TestDrive 'design/20-contract-missing.md')
        $result.Finding | Should -Not -BeNullOrEmpty
        $result.Finding.Class | Should -Be 'ClassListDisagreement'
    }

    It 'S5.1: ContractListUnreadable is could-not-evaluate when the contract document cannot be found' {
        $result = Test-ClassListAgreement -ContractPath (Join-Path $TestDrive 'design/does-not-exist.md')
        $result.CouldNotEvaluate | Should -Not -BeNullOrEmpty
        $result.CouldNotEvaluate.Reason | Should -Be 'ContractListUnreadable'
        $result.Finding | Should -BeNullOrEmpty
    }

    It 'the DesignStateFailure header cell in the "could not evaluate" table is not read as a class id' -Tag 'NearMiss','ClassListDisagreement' {
        New-TreeFile -RelativePath 'design/20-contract.md' -Content $script:MinimalContract
        $parsed = Get-ContractClassIds -ContractPath (Join-Path $TestDrive 'design/20-contract.md')
        $parsed.Ids.CouldNotEvaluate | Should -Not -Contain 'DesignStateFailure'
    }
}

Describe 'Test-DesignState: GlobDisagreement (#74)' {

    BeforeAll {
        # A throwaway tree carrying one artifact per globbed kind plus one of each exclusion, so
        # every case below varies only the contract table against a tree that does not move.
        $script:GlobRoot = Join-Path $TestDrive 'globfixture'
        foreach ($rel in @(
            '.claude/commands/alpha.md', '.claude/commands/beta-local.md',
            'tools/Thing.ps1', 'tools/Thing.Tests.ps1',
            'design/10-design.md', 'design/FROZEN.md',
            'templates/design/00-brief.md', 'templates/design/CLAUDE.md',
            'README.md', 'CLAUDE.md',
            '.claude/COMPANIONS.md', '.github/ISSUE_TEMPLATE/bug.md', 'codex/PROFILES.md'
        )) {
            $full = Join-Path $script:GlobRoot $rel
            New-Item -ItemType Directory -Path (Split-Path $full -Parent) -Force | Out-Null
            Set-Content -LiteralPath $full -Value 'x' -Encoding utf8NoBOM
        }

        # The table as design/20-contract.md carries it. Each test below rewrites one cell.
        $script:GlobTable = @'
| Kind | Glob | Excluded |
|---|---|---|
| command | `.claude/commands/*.md` | `*-local.md` |
| script | `tools/*.ps1` | `*.Tests.ps1` |
| document | `design/*.md`, `templates/design/*.md`, `*.md`, `.claude/COMPANIONS.md`, `.github/ISSUE_TEMPLATE/*.md`, `codex/PROFILES.md` | `design/FROZEN.md`, `CLAUDE.md` |
| invariant | not a tree path | — |

trailing prose
'@

        function New-GlobContract {
            param([Parameter(Mandatory)][string] $Name, [Parameter(Mandatory)][string] $Table)
            $full = Join-Path $TestDrive "globcontracts/$Name.md"
            New-Item -ItemType Directory -Path (Split-Path $full -Parent) -Force | Out-Null
            Set-Content -LiteralPath $full -Value $Table -Encoding utf8NoBOM
            $full
        }
    }

    It 'raises nothing when every kind resolves to exactly what the checker enumerates' -Tag 'NearMiss','GlobDisagreement' {
        $path = New-GlobContract -Name 'agree' -Table $script:GlobTable
        $result = Test-GlobDisagreement -RepoPath $script:GlobRoot -ContractPath $path
        $result.Findings | Should -BeNullOrEmpty
        $result.CouldNotEvaluate | Should -BeNullOrEmpty
    }

    It 'fires when the contract drops an exclusion the checker still applies' -Tag 'Fires','GlobDisagreement' {
        $table = $script:GlobTable -replace '\| `\*-local\.md` \|', '| — |'
        $path = New-GlobContract -Name 'no-local-exclusion' -Table $table
        $result = Test-GlobDisagreement -RepoPath $script:GlobRoot -ContractPath $path
        $result.Findings.Class | Should -Contain 'GlobDisagreement'
        $finding = @($result.Findings | Where-Object { $_.Subject -eq 'command' })[0]
        $finding.Detail | Should -Match 'the contract''s patterns reach'
        $finding.Detail | Should -Match 'beta-local\.md'
        $finding.Blocking | Should -BeTrue
    }

    It 'fires when the checker enumerates a location the contract''s patterns do not reach' -Tag 'Fires','GlobDisagreement' {
        $table = $script:GlobTable -replace ', `\.github/ISSUE_TEMPLATE/\*\.md`', ''
        $path = New-GlobContract -Name 'no-issue-templates' -Table $table
        $result = Test-GlobDisagreement -RepoPath $script:GlobRoot -ContractPath $path
        $finding = @($result.Findings | Where-Object { $_.Subject -eq 'document' })[0]
        $finding.Detail | Should -Match 'the checker enumerates'
        $finding.Detail | Should -Match 'ISSUE_TEMPLATE/bug\.md'
    }

    <#
        The case Option 1A could not have caught, and the reason this class compares resolved
        file sets. The document row still names exactly two exclusions - the token count and
        every other token are unchanged - but one of them changes scope from a
        repository-relative path to a basename pattern, so it now also excludes
        templates/design/CLAUDE.md, which Get-DocumentGlobFiles still enumerates.
    #>
    It 'fires when an exclusion changes scope while the token list stays the same size' -Tag 'Fires','GlobDisagreement' {
        $table = $script:GlobTable -replace '`design/FROZEN\.md`, `CLAUDE\.md`', '`design/FROZEN.md`, `*CLAUDE.md`'
        $path = New-GlobContract -Name 'exclusion-scope' -Table $table
        $result = Test-GlobDisagreement -RepoPath $script:GlobRoot -ContractPath $path
        $finding = @($result.Findings | Where-Object { $_.Subject -eq 'document' })[0]
        $finding | Should -Not -BeNullOrEmpty
        $finding.Detail | Should -Match 'templates/design/CLAUDE\.md'
    }

    It 'does not fire merely because an exclusion path repeats a basename elsewhere in the tree' -Tag 'NearMiss','GlobDisagreement' {
        # templates/design/CLAUDE.md and CLAUDE.md share a basename; only the latter is excluded
        # on both sides, which is the near-miss the case above turns into a fire.
        $path = New-GlobContract -Name 'basename-collision' -Table $script:GlobTable
        $result = Test-GlobDisagreement -RepoPath $script:GlobRoot -ContractPath $path
        $result.Findings | Should -BeNullOrEmpty
    }

    It 'fires when the table carries no patterns for a kind the checker enumerates' -Tag 'Fires','GlobDisagreement' {
        $table = $script:GlobTable -replace '\| script \| `tools/\*\.ps1` \| `\*\.Tests\.ps1` \|\r?\n', ''
        $path = New-GlobContract -Name 'no-script-row' -Table $table
        $result = Test-GlobDisagreement -RepoPath $script:GlobRoot -ContractPath $path
        $finding = @($result.Findings | Where-Object { $_.Subject -eq 'script' })[0]
        $finding.Detail | Should -Match 'carries no patterns for it'
    }

    It 'does not compare the invariant row, which has no pattern in either cell' -Tag 'NearMiss','GlobDisagreement' {
        $parsed = Get-ContractGlobPatterns -ContractPath (New-GlobContract -Name 'invariant-row' -Table $script:GlobTable)
        $parsed.Failure | Should -BeNullOrEmpty
        $parsed.Kinds.Keys | Should -Not -Contain 'invariant'
        $parsed.Kinds.Keys | Should -Contain 'document'
    }

    It 'reports ContractListUnreadable - uncomputed, never clean - when the table cannot be read' {
        $result = Test-GlobDisagreement -RepoPath $script:GlobRoot -ContractPath (Join-Path $TestDrive 'globcontracts/absent.md')
        $result.Findings | Should -BeNullOrEmpty
        $result.CouldNotEvaluate.Reason | Should -Be 'ContractListUnreadable'
        $result.CouldNotEvaluate.Detail | Should -Match 'uncomputed, not clean'
    }

    It 'reports ContractListUnreadable when the document exists but carries no glob table' {
        $path = New-GlobContract -Name 'no-table' -Table "# Contract`n`nnothing tabular here`n"
        $result = Test-GlobDisagreement -RepoPath $script:GlobRoot -ContractPath $path
        $result.CouldNotEvaluate.Reason | Should -Be 'ContractListUnreadable'
        $result.CouldNotEvaluate.Detail | Should -Match 'GlobTableNotFound'
    }

    It 'this repository''s own table and its own enumeration agree' -Tag 'NearMiss','GlobDisagreement' -Skip:$script:SkipDesignStateSelfTests {
        $repo = Split-Path $PSScriptRoot -Parent
        $result = Test-GlobDisagreement -RepoPath $repo -ContractPath (Join-Path $repo 'design/20-contract.md')
        $result.CouldNotEvaluate | Should -BeNullOrEmpty
        $result.Findings | Should -BeNullOrEmpty
    }
}

Describe 'Test-DesignState: the freeze gate (S5.8)' {

    BeforeEach {
        Remove-Item -LiteralPath (Join-Path $TestDrive 'design/FROZEN.md') -Force -ErrorAction SilentlyContinue
    }

    It 'downgrades every blocking finding to reported, states the count, and reproduces the marker verbatim' {
        New-TreeFile -RelativePath 'design/FROZEN.md' -Content @'
# design/ is frozen

Frozen at: abc1234, 2026-08-19
Frozen because: escaping the generative loop
Lifts when: tier one is code-complete

To lift: run `/unfreeze`.
'@
        $marker = Get-FreezeMarker -RepoPath $TestDrive
        $marker | Should -Not -BeNullOrEmpty
        $marker.FrozenBecause | Should -Be 'Frozen because: escaping the generative loop'
        $marker.LiftsWhen | Should -Be 'Lifts when: tier one is code-complete'
    }

    It 'returns null when design/FROZEN.md does not exist' {
        $marker = Get-FreezeMarker -RepoPath $TestDrive
        $marker | Should -BeNullOrEmpty
    }
}

Describe 'Test-DesignState: the projector seam (S5.10)' {

    It 'reports Ran = $false when tools/Update-DesignProjection.ps1 does not exist' {
        $result = Invoke-Projector -RepoPath $TestDrive
        $result.Ran | Should -BeFalse
        $result.Detail | Should -Match 'does not exist'
    }

    It 'reports Ran = $false when the projector exits non-zero' {
        New-TreeFile -RelativePath 'tools/Update-DesignProjection.ps1' -Content 'exit 1'
        $result = Invoke-Projector -RepoPath $TestDrive
        $result.Ran | Should -BeFalse
    }

    It 'reports Ran = $true when the projector exits zero' {
        New-TreeFile -RelativePath 'tools/Update-DesignProjection.ps1' -Content 'param([string]$Path,[switch]$DryRun) exit 0'
        $result = Invoke-Projector -RepoPath $TestDrive
        $result.Ran | Should -BeTrue
    }

    It 'S7.9: captures the projector''s -DryRun regions as structured objects, not just the exit code' {
        New-TreeFile -RelativePath 'tools/Update-DesignProjection.ps1' -Content @'
param([string]$Path,[switch]$DryRun)
[pscustomobject]@{ Document = 'x.md'; Id = 'units'; Content = 'rendered' } | ConvertTo-Json
exit 0
'@
        $result = Invoke-Projector -RepoPath $TestDrive
        $result.Ran | Should -BeTrue
        $result.Regions.Count | Should -Be 1
        $result.Regions[0].Id | Should -Be 'units'
    }
}

Describe 'Test-DesignState: ProjectionStale (S7.9)' {

    It 'fires when the tree''s region body differs from the projector''s rendering' -Tag 'Fires','ProjectionStale' {
        New-TreeFile -RelativePath 'x.md' -Content @'
# X

<!-- units:start -->
old content
<!-- units:end -->
'@
        $regions = @([pscustomobject]@{ Document = 'x.md'; Id = 'units'; Content = 'new content' })
        $findings = Test-ProjectionStale -Regions $regions -RepoPath $TestDrive
        $findings.Count | Should -Be 1
        $findings[0].Class | Should -Be 'ProjectionStale'
    }

    It 'does not fire when the tree''s region body matches the projector''s rendering exactly' -Tag 'NearMiss','ProjectionStale' {
        New-TreeFile -RelativePath 'x.md' -Content @'
# X

<!-- units:start -->
same content
<!-- units:end -->
'@
        $regions = @([pscustomobject]@{ Document = 'x.md'; Id = 'units'; Content = 'same content' })
        $findings = Test-ProjectionStale -Regions $regions -RepoPath $TestDrive
        $findings.Count | Should -Be 0
    }

    It 'S7.9: does not fire when the only difference is CRLF against LF' -Tag 'NearMiss','ProjectionStale' {
        New-TreeFile -RelativePath 'x.md' -Content "# X`r`n`r`n<!-- units:start -->`r`nline one`r`nline two`r`n<!-- units:end -->`r`n"
        $regions = @([pscustomobject]@{ Document = 'x.md'; Id = 'units'; Content = "line one`nline two" })
        $findings = Test-ProjectionStale -Regions $regions -RepoPath $TestDrive
        $findings.Count | Should -Be 0
    }

    It 'skips a region with no Document (the agent projection - no tree region to compare against)' -Tag 'NearMiss','ProjectionStale' {
        $regions = @([pscustomobject]@{ Document = $null; Id = 'agent'; Content = 'anything' })
        $findings = Test-ProjectionStale -Regions $regions -RepoPath $TestDrive
        $findings.Count | Should -Be 0
    }
}

Describe 'Test-DesignState: the tracker classes (S5.11)' {

    It 'S5.11: gh unavailable yields TrackerUnavailable, names WorkStateDivergence as not compared, and MirrorStale still runs' {
        Mock -CommandName Test-TrackerAvailable -MockWith { $false }

        $ref = New-Record -Id 'work/42' -Kind 'WorkRef' -Scalars @{ Issue = '42'; State = 'open'; MirroredAt = 'deadbeef' }
        $result = Test-TrackerClasses -Records @($ref) -RepoPath $TestDrive -Repository 'x/y'

        ($result.CouldNotEvaluate | Where-Object { $_.Reason -eq 'TrackerUnavailable' }).Count | Should -Be 1
        $result.CouldNotEvaluate[0].Detail | Should -Match 'WorkStateDivergence not compared'
    }

    It 'MirrorStale fires when a WorkRef''s MirroredAt is not the current commit' {
        Mock -CommandName Test-TrackerAvailable -MockWith { $false }
        Mock -CommandName Get-CurrentCommitSha -MockWith { 'currentsha' }

        $ref = New-Record -Id 'work/42' -Kind 'WorkRef' -Scalars @{ Issue = '42'; MirroredAt = 'stalesha' }
        $result = Test-TrackerClasses -Records @($ref) -RepoPath $TestDrive -Repository 'x/y'

        (@($result.Reported | Where-Object { $_.Class -eq 'MirrorStale' })).Count | Should -Be 1
    }

    It 'MirrorStale does not fire when MirroredAt matches the current commit' {
        Mock -CommandName Test-TrackerAvailable -MockWith { $false }
        Mock -CommandName Get-CurrentCommitSha -MockWith { 'currentsha' }
        Mock -CommandName Test-CommitIsAncestor -MockWith { 'Ancestor' }

        $ref = New-Record -Id 'work/42' -Kind 'WorkRef' -Scalars @{ Issue = '42'; MirroredAt = 'currentsha' }
        $result = Test-TrackerClasses -Records @($ref) -RepoPath $TestDrive -Repository 'x/y'

        (@($result.Reported | Where-Object { $_.Class -eq 'MirrorStale' })).Count | Should -Be 0
    }

    It 'PinAncestry fires when MirroredAt is not an ancestor of HEAD, and does not need gh' {
        Mock -CommandName Test-TrackerAvailable -MockWith { $false }
        Mock -CommandName Get-CurrentCommitSha -MockWith { 'currentsha' }
        Mock -CommandName Test-CommitIsAncestor -MockWith { 'NotAncestor' }

        $ref = New-Record -Id 'work/42' -Kind 'WorkRef' -Scalars @{ Issue = '42'; MirroredAt = 'orphaned' }
        $result = Test-TrackerClasses -Records @($ref) -RepoPath $TestDrive -Repository 'x/y'

        (@($result.Reported | Where-Object { $_.Class -eq 'PinAncestry' })).Count | Should -Be 1
    }

    It 'ShallowCheckout is could-not-evaluate, and never a pass, when ancestry cannot be resolved' {
        Mock -CommandName Test-TrackerAvailable -MockWith { $false }
        Mock -CommandName Get-CurrentCommitSha -MockWith { 'currentsha' }
        Mock -CommandName Test-CommitIsAncestor -MockWith { 'Unresolvable' }

        $ref = New-Record -Id 'work/42' -Kind 'WorkRef' -Scalars @{ Issue = '42'; MirroredAt = 'orphaned' }
        $result = Test-TrackerClasses -Records @($ref) -RepoPath $TestDrive -Repository 'x/y'

        ($result.CouldNotEvaluate | Where-Object { $_.Reason -eq 'ShallowCheckout' }).Count | Should -Be 1
        (@($result.Reported | Where-Object { $_.Class -eq 'PinAncestry' })).Count | Should -Be 0
    }

    It 'no WorkRef records: every tracker class runs to completion with nothing to report' {
        Mock -CommandName Test-TrackerAvailable -MockWith { $true }
        $result = Test-TrackerClasses -Records @() -RepoPath $TestDrive -Repository 'x/y'
        $result.Reported.Count | Should -Be 0
        $result.CouldNotEvaluate.Count | Should -Be 0
    }

    It '#162: the per-issue gh issue view call is scoped with -R when -Repository is given' {
        Mock -CommandName Test-TrackerAvailable -MockWith { $true }
        Mock -CommandName Invoke-GhRaw -MockWith {
            param([string[]] $GhArgs)
            $script:CapturedGhArgs = $GhArgs
            [pscustomobject]@{ ExitCode = 0; Output = '{"title":"t","state":"open"}' }
        }

        $ref = New-Record -Id 'work/42' -Kind 'WorkRef' -Scalars @{ Issue = '42'; State = 'open'; Title = 't' }
        Test-TrackerClasses -Records @($ref) -RepoPath $TestDrive -Repository 'x/y' | Out-Null

        $script:CapturedGhArgs | Should -Contain '-R'
        $script:CapturedGhArgs[$script:CapturedGhArgs.IndexOf('-R') + 1] | Should -Be 'x/y'
    }
}

Describe 'Test-DesignState: end-to-end (S5.2, S5.3, S5.4, S5.9)' {

    BeforeEach {
        Get-ChildItem $TestDrive -ErrorAction SilentlyContinue -Recurse -File |
            Remove-Item -Force -ErrorAction SilentlyContinue
        New-TreeFile -RelativePath 'design/20-contract.md' -Content $script:MinimalContract
        New-TreeFile -RelativePath 'design/90-decisions.md' -Content "# Decisions`n"
    }

    It 'S5.4: an absent design/state/ yields StateSetAbsent, exit 2, and zero findings - never clean' {
        $result = Invoke-DesignStateCheck -RepoPath $TestDrive

        $result.ExitCode | Should -Be 2
        $result.Findings.Count | Should -Be 0
        $result.Reported.Count | Should -Be 0
        (@($result.CouldNotEvaluate | Where-Object { $_.Reason -eq 'StateSetAbsent' })).Count | Should -Be 1
    }

    It '#244: a ClassListDisagreement finding survives the StateSetAbsent short-circuit rather than being discarded' {
        # A contract whose Blocking table omits the ClassListDisagreement row itself - it is a
        # tree fact the script's own $script:BlockingClasses declares that the contract's copy
        # then disagrees with, computed before the StateSetAbsent early return regardless of
        # whether design/state/ holds any records.
        $missingClassListId = $script:MinimalContract -replace '(?m)^\| `ClassListDisagreement` \| x \| x \|\r?\n', ''
        New-TreeFile -RelativePath 'design/20-contract.md' -Content $missingClassListId

        $result = Invoke-DesignStateCheck -RepoPath $TestDrive

        $result.ExitCode | Should -Be 2
        (@($result.CouldNotEvaluate | Where-Object { $_.Reason -eq 'StateSetAbsent' })).Count | Should -Be 1
        $result.Findings.Count | Should -Be 1
        $result.Findings[0].Class | Should -Be 'ClassListDisagreement'
    }

    It '#113: design/state/ holding only WorkRef records still yields StateSetAbsent, not UnrecordedArtifact' {
        New-StateFile -RelativePath 'work/1.md' -Content @'
# work/1
Issue: 1
Title: x
State: OPEN
Rank: 1
MirroredAt: abc123
Criteria:
'@
        $result = Invoke-DesignStateCheck -RepoPath $TestDrive

        (@($result.CouldNotEvaluate | Where-Object { $_.Reason -eq 'StateSetAbsent' })).Count | Should -Be 1
        $result.ExitCode | Should -Be 2
        $result.Findings.Count | Should -Be 0
    }

    It '#113: design/state/ holding any non-WorkRef record does not yield StateSetAbsent' {
        New-StateFile -RelativePath 'work/1.md' -Content @'
# work/1
Issue: 1
Title: x
State: OPEN
Rank: 1
MirroredAt: abc123
Criteria:
'@
        New-StateFile -RelativePath 'units/command/a.md' -Content @'
# unit/command/a
Kind: command
Status: active
Binds: I999
'@
        $result = Invoke-DesignStateCheck -RepoPath $TestDrive

        (@($result.CouldNotEvaluate | Where-Object { $_.Reason -eq 'StateSetAbsent' })).Count | Should -Be 0
    }

    It 'S5.2: all three lists are always present, even when empty (checked on the absent-state-set path)' {
        $result = Invoke-DesignStateCheck -RepoPath $TestDrive
        ($null -eq $result.Findings) | Should -BeFalse
        ($null -eq $result.Reported) | Should -BeFalse
        ($null -eq $result.CouldNotEvaluate) | Should -BeFalse
    }

    It 'S5.3: exit code is 2 (could-not-evaluate) even when a blocking finding also exists, in a run with records' {
        New-StateFile -RelativePath 'units/command/a.md' -Content @'
# unit/command/a
Kind: command
Status: active
Binds: I999
'@
        # ProjectorFailed always fires today (no projector exists), guaranteeing a could-not-evaluate
        # alongside the UnresolvedId blocking finding this record also produces.
        $result = Invoke-DesignStateCheck -RepoPath $TestDrive

        (@($result.Findings | Where-Object { $_.Class -eq 'UnresolvedId' })).Count | Should -Be 1
        $result.CouldNotEvaluate.Count | Should -BeGreaterThan 0
        $result.ExitCode | Should -Be 2
    }

    It 'S5.9: git status --short is empty after a run that found blocking divergences' {
        Push-Location $TestDrive
        try {
            & git init --quiet 2>$null
            & git config user.email 'test@example.com' 2>$null
            & git config user.name 'Test' 2>$null
            & git add -A 2>$null
            & git commit --quiet -m 'seed' 2>$null

            New-StateFile -RelativePath 'units/command/a.md' -Content @'
# unit/command/a
Kind: command
Status: active
Binds: I999
'@
            $before = & git status --short
            $null = Invoke-DesignStateCheck -RepoPath $TestDrive
            $after = & git status --short

            # Only the new untracked state file (created above, outside the checker's own run)
            # should differ - the checker itself must not have written anything.
            $after | Should -Be $before
        } finally {
            Pop-Location
        }
    }

    It 'S5.8/I21: exit 2 still stands during a freeze, even with every blocking class downgraded to reported' {
        New-TreeFile -RelativePath 'design/FROZEN.md' -Content @'
# design/ is frozen

Frozen at: abc1234, 2026-08-19
Frozen because: escaping the generative loop
Lifts when: tier one is code-complete
'@
        New-StateFile -RelativePath 'units/command/a.md' -Content @'
# unit/command/a
Kind: command
Status: active
Binds: I999
'@
        $result = Invoke-DesignStateCheck -RepoPath $TestDrive

        $result.Findings.Count | Should -Be 0
        (@($result.Reported | Where-Object { $_.Class -eq 'UnresolvedId' })).Count | Should -Be 1
        $result.ExitCode | Should -Be 2
        $result.DowngradedCount | Should -BeGreaterThan 0
    }
}

Describe 'Test-DesignState against this repository''s own tree' -Skip:$script:SkipDesignStateSelfTests {

    BeforeAll {
        $script:RepoRoot = Split-Path $PSScriptRoot -Parent
        $script:StatusBefore = & git -C $script:RepoRoot status --short
        $script:RealResult = Invoke-DesignStateCheck -RepoPath $script:RepoRoot
    }

    It 'S5.9/I18: git status is unchanged by a real run against this repository' {
        $after = & git -C $script:RepoRoot status --short
        $after | Should -Be $script:StatusBefore
    }

    It 'S5.1: this repository''s design/20-contract.md declares exactly the same class ids as the script' {
        (@($script:RealResult.Findings | Where-Object { $_.Class -eq 'ClassListDisagreement' })).Count | Should -Be 0
    }

    It 'S5.6: the real run names a largest closure, its unit, and its largest contributor' {
        $script:RealResult.LargestClosure | Should -Not -BeNullOrEmpty
        $script:RealResult.LargestClosure.Unit | Should -Not -BeNullOrEmpty
        $script:RealResult.LargestClosure.LargestContributor | Should -Not -BeNullOrEmpty
    }

    It 'S23.2: the closure of unit/document/agents-md equals its own record and every id it names directly - never AGENTS.md itself - and AGENTS.md''s own length is reported separately as its artifact' {
        $graph = Read-DesignStateGraph -Path $script:RepoRoot
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        $root = $byId['unit/document/agents-md']

        $members = Get-DesignClosure -Root $root -ById $byId
        @($members | Where-Object { $_.Kind -eq 'Artifact' }).Count | Should -Be 0
        $expected = 0
        foreach ($m in $members) {
            $expected += (Get-Item -LiteralPath (Join-Path $script:RepoRoot $m.Path)).Length
        }

        $agentsMdBytes = (Get-Item -LiteralPath (Join-Path $script:RepoRoot 'AGENTS.md')).Length
        Get-UnitArtifactBytes -RepoPath $script:RepoRoot -Root $root | Should -Be $agentsMdBytes

        $result = Test-ClosureBudget -Records $graph.Records -ById $byId -RepoPath $script:RepoRoot
        # S24 absorbed enough of this unit's Live for its records to fit the ceiling, so the
        # finding is present exactly when the measured closure exceeds it - and when it is, it
        # carries the bounded figure and the artifact figure separately.
        $finding = @($result.Findings | Where-Object { $_.Subject -eq 'unit/document/agents-md' })
        $finding.Count | Should -Be ([int]($expected -gt 16384))
        if ($finding.Count -eq 1) {
            $finding[0].Detail | Should -Match "closure is $expected bytes"
            $finding[0].Detail | Should -Match "unit's own artifact is $agentsMdBytes bytes"
        }
    }

    It 'S20.7: every non-empty retired half sits in a companion file and not in an active record' {
        (@($script:RealResult.Findings | Where-Object { $_.Class -eq 'RecordPairMalformed' })).Count | Should -Be 0
        (@($script:RealResult.Findings | Where-Object { $_.Class -eq 'HalfStatusMismatch' })).Count | Should -Be 0
        (@($script:RealResult.Findings | Where-Object { $_.Class -eq 'HalfOverlap' })).Count | Should -Be 0
    }

    It 'S20.9: I23 and I30 carry Enforcement: code with Evidence naming the tests that hold them' {
        $graph = Read-DesignStateGraph -Path $script:RepoRoot
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        foreach ($id in 'I23', 'I30') {
            $byId[$id].Scalars['Enforcement'] | Should -Be 'code'
            $byId[$id].Lists['Evidence'] | Should -Not -BeNullOrEmpty
        }
    }

    It 'S21.5: one real absorption lands - decision/2026-08-04-session-boundaries-are-policy-in-agents-md is stated in unit/document/agents-md and dropped from its Live, and the run reports no SiteAmbiguous, SiteOutOfReach or SiteContradictsLive for it' {
        $graph = Read-DesignStateGraph -Path $script:RepoRoot
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }

        $decisionId = 'decision/2026-08-04-session-boundaries-are-policy-in-agents-md'
        $byId[$decisionId].Lists['StatedIn'] | Should -Be @('unit/document/agents-md § Session boundaries')
        $byId['unit/document/agents-md'].Lists['Live'] | Should -Not -Contain $decisionId

        foreach ($class in 'SiteAmbiguous', 'SiteOutOfReach', 'SiteContradictsLive') {
            @($script:RealResult.Findings | Where-Object { $_.Class -eq $class -and $_.Subject -match $decisionId -or ($_.Class -eq $class -and $_.Detail -match $decisionId) }).Count | Should -Be 0
        }

        $afterMembers = Get-DesignClosure -Root $byId['unit/document/agents-md'] -ById $byId
        @($afterMembers | ForEach-Object { $_.Id }) | Should -Not -Contain $decisionId
    }

    It 'S21.5: absorbing the decision shrinks unit/document/agents-md''s closure by exactly that decision record''s length' {
        # Isolates exactly what the criterion measures - the byte cost of one more Live member -
        # by comparing against an in-memory root whose Live differs by only the absorbed decision
        # id. Reverting the real files on disk would also shrink the unit's own record (the Live
        # line itself gets shorter), which is a second, unrelated saving the criterion does not
        # claim; this keeps every other byte fixed.
        $decisionId = 'decision/2026-08-04-session-boundaries-are-policy-in-agents-md'
        $graph = Read-DesignStateGraph -Path $script:RepoRoot
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }

        $afterRoot = $byId['unit/document/agents-md']
        $afterMembers = Get-DesignClosure -Root $afterRoot -ById $byId
        $afterBytes = ($afterMembers | ForEach-Object { Get-RecordFileBytes -RepoPath $script:RepoRoot -Record $_ } | Measure-Object -Sum).Sum

        $clonedLists = $afterRoot.Lists.Clone()
        $clonedLists['Live'] = @($afterRoot.Lists['Live']) + @($decisionId)
        $beforeRoot = New-DesignRecord -Id $afterRoot.Id -Kind $afterRoot.Kind -Path $afterRoot.Path `
            -Scalars $afterRoot.Scalars -Lists $clonedLists -Prose $afterRoot.Prose
        $beforeMembers = Get-DesignClosure -Root $beforeRoot -ById $byId
        $beforeBytes = ($beforeMembers | ForEach-Object { Get-RecordFileBytes -RepoPath $script:RepoRoot -Record $_ } | Measure-Object -Sum).Sum

        ($beforeMembers | ForEach-Object { $_.Id }) | Should -Contain $decisionId
        $decisionBytes = Get-RecordFileBytes -RepoPath $script:RepoRoot -Record $byId[$decisionId]
        ($beforeBytes - $afterBytes) | Should -Be $decisionBytes
    }

    It 'S24.1/S24.4: every decision whose terms stand in AGENTS.md carries a StatedIn site naming that section and is absent from unit/document/agents-md''s Live' {
        $graph = Read-DesignStateGraph -Path $script:RepoRoot
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }
        $absorbed = @{
            'decision/2026-08-10-frozen-md-marker'                                   = 'The design freeze'
            'decision/2026-08-02-house-convention-path-corrected'                    = 'House conventions'
            'decision/2026-08-03-reconciliation-ends-in-decision-not-report'         = 'Working with me'
            'decision/2026-08-03-issues-read-human-first-agent-detail-collapsed'     = 'Tracking work'
            'decision/2026-08-03-work-defers-to-github-track-owns-github-writes'     = 'Tracking work'
            'decision/2026-08-04-cost-measured-by-script-taxonomy-is-policy'         = 'What should stop being model work'
            'decision/2026-08-12-codex-vendor-alias-list-for-sol-terra'              = 'Vendor model aliases'
            'decision/2026-08-19-marked-region-marker-declares-its-own-kind'         = 'Marked regions'
            'decision/2026-08-24-codex-tier-resolved-from-config'                    = 'Vendor model aliases'
            'decision/2026-08-30-force-delete-delegated-on-tip-comparison'           = 'Git and delivery'
            'decision/2026-08-30-tier-gate-reads-environment-stamp-first'            = 'Vendor model aliases'
        }
        $live = @($byId['unit/document/agents-md'].Lists['Live'])
        foreach ($id in $absorbed.Keys) {
            $byId[$id].Lists['StatedIn'] | Should -Contain "unit/document/agents-md § $($absorbed[$id])" -Because "$id must be stated in AGENTS.md"
            $live | Should -Not -Contain $id -Because "$id must leave Live in the same commit"
        }
        @($script:RealResult.Findings | Where-Object { $_.Class -eq 'DecisionUnplaced' }).Count | Should -Be 0
    }

    It 'S24.3: SiteAmbiguous, SiteOutOfReach and SiteContradictsLive are all silent against this repository' {
        foreach ($class in 'SiteAmbiguous', 'SiteOutOfReach', 'SiteContradictsLive') {
            @($script:RealResult.Findings | Where-Object { $_.Class -eq $class }).Count | Should -Be 0 -Because "$class must be silent"
        }
    }

    It 'S24.5: the checker reports no ClosureOverBudget finding for unit/document/agents-md' {
        @($script:RealResult.Findings | Where-Object { $_.Class -eq 'ClosureOverBudget' -and $_.Subject -eq 'unit/document/agents-md' }).Count | Should -Be 0
    }

    It 'S30.1/S30.2: LiveAlreadyStated never fires against this repository, in either list' {
        (@($script:RealResult.Findings | Where-Object { $_.Class -eq 'LiveAlreadyStated' })).Count | Should -Be 0
        (@($script:RealResult.Reported | Where-Object { $_.Class -eq 'LiveAlreadyStated' })).Count | Should -Be 0
    }

    It 'S30.5: decision/2026-09-02-livealreadystated-is-the-reported-class carries all three StatedIn sites and has left unit/script/test-designstate''s Live' {
        $graph = Read-DesignStateGraph -Path $script:RepoRoot
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }

        $decisionId = 'decision/2026-09-02-livealreadystated-is-the-reported-class'
        $byId[$decisionId].Lists['StatedIn'] | Should -Be @(
            'unit/document/design-20-contract § The divergence classes',
            'contract/test-designstate § Semantics',
            'unit/command/reconcile § LiveAlreadyStated'
        )
        $byId['unit/script/test-designstate'].Lists['Live'] | Should -Not -Contain $decisionId

        foreach ($class in 'SiteAmbiguous', 'SiteOutOfReach', 'SiteContradictsLive') {
            @($script:RealResult.Findings | Where-Object { $_.Class -eq $class -and ($_.Subject -match [regex]::Escape($decisionId) -or $_.Detail -match [regex]::Escape($decisionId)) }).Count | Should -Be 0
        }
    }

    It 'S30.6: unit/script/test-designstate''s bounded closure is strictly lower after absorbing the decision than the 15,054 bytes it measured before' {
        $graph = Read-DesignStateGraph -Path $script:RepoRoot
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }

        $root = $byId['unit/script/test-designstate']
        $afterMembers = Get-DesignClosure -Root $root -ById $byId
        $afterBytes = ($afterMembers | ForEach-Object { Get-RecordFileBytes -RepoPath $script:RepoRoot -Record $_ } | Measure-Object -Sum).Sum

        $afterBytes | Should -BeLessThan 15054
    }

    It 'S22.7: ClassListDisagreement is silent - DecisionUnplaced and SupersessionCycle now land, closing the gap S21.6 left open' {
        (@($script:RealResult.Findings | Where-Object { $_.Class -eq 'ClassListDisagreement' })).Count | Should -Be 0
    }

    It 'S22.4: the five records issue #151 names each carry the edge or the site they lack, and DecisionUnplaced reports none of them' {
        $graph = Read-DesignStateGraph -Path $script:RepoRoot
        $byId = @{}
        foreach ($r in $graph.Records) { $byId[$r.Id] = $r }

        $byId['unit/command/slice'].CompanionPath | Should -Not -BeNullOrEmpty
        $slicedCompanionLists = @($byId['unit/command/slice'].Lists['Archival'])
        $slicedCompanionLists | Should -Contain 'decision/2026-08-03-ticking-checkbox-is-the-users'

        foreach ($id in 'decision/2026-08-21-install-delivers-on-a-feature-branch',
            'decision/2026-08-25-branch-commit-push-pr-delegated-for-all-work',
            'decision/2026-08-25-code-review-defaults-high-effort-fix-push',
            'decision/2026-08-25-high-volume-tier-retired-haiku-luna-removed') {
            $byId[$id].Lists['StatedIn'] | Should -Not -BeNullOrEmpty
        }

        (@($script:RealResult.Findings | Where-Object { $_.Class -eq 'DecisionUnplaced' })).Count | Should -Be 0
    }

    It 'S22.6: SupersessionCycle reports none against this repository''s own decisions' {
        (@($script:RealResult.Findings | Where-Object { $_.Class -eq 'SupersessionCycle' })).Count | Should -Be 0
    }

    It 'S12.5/S25.4: the check reports zero findings against this repository and exits 0' {
        # Replaces S5's 'never clean against this repository', whose stated reason - that most
        # commands, scripts and documents had no unit record - stopped being true at S8 and S9.
        # It kept passing on a divergence it was never written to describe, which is the shape
        # AGENTS.md (Verification) calls a test that guards nothing.
        #
        # It then asserted exit 0, which stopped being true at S19: counting a unit's own
        # artifact puts every document unit over the ceiling, and design/10-design.md
        # ("Whether the ceiling can be met") says so outright - the brief's Abandonment line is
        # live and the adjudication is the user's. A blanket exit-0 assertion turned that
        # designed state into a permanently red build, which is the same defect one level up:
        # a gate whose value is constant reports nothing.
        #
        # S23 re-scoped the adjudicated case again: the ceiling now excludes the unit's own
        # artifact, so a breach could no longer be artifact-dominated - every remaining breach
        # named a record, which is what made it absorption-remediable (S23.4, S23.6). S24 and
        # S25 ran that absorption pass, one unit each - unit/document/agents-md and
        # unit/document/design-20-contract - and this is the first run in which the whole kit
        # reports itself inside the budget it set: zero findings, exit 0.
        $failing = @($script:RealResult.Findings | ForEach-Object { "[$($_.Class)] $($_.Subject): $($_.Detail)" })
        $unevaluated = @($script:RealResult.CouldNotEvaluate | ForEach-Object { "[$($_.Reason)] $($_.Detail)" })

        $script:RealResult.CouldNotEvaluate | Should -BeNullOrEmpty -Because "could not evaluate: $($unevaluated -join ' | ')"
        $script:RealResult.Findings | Should -BeNullOrEmpty -Because "findings: $($failing -join ' | ')"
        $script:RealResult.ExitCode | Should -Be 0 -Because "findings: $($failing -join ' | ')"

        $script:RealResult.LargestClosure.Unit | Should -Not -BeNullOrEmpty
        $script:RealResult.LargestClosure.Bytes | Should -BeGreaterThan 0
    }

    It 'S7.9: the projector runs against this repository and ProjectionStale does not fire - the committed regions match their regeneration' {
        $script:RealResult.CouldNotEvaluate | Where-Object { $_.Reason -eq 'ProjectorFailed' } | Should -BeNullOrEmpty
        (@($script:RealResult.Findings | Where-Object { $_.Class -eq 'ProjectionStale' })).Count | Should -Be 0
    }

    It 'S16.1/S16.2: this repository has one Contract record per design/20-contract.md Public-surface entry, and OwnerMismatch reports none' {
        # This asserted a hardcoded count, which went stale three times as the section
        # legitimately grew - 8 to 9 at S14, to 10 on 2026-08-31, to 14 on 2026-09-05 - and
        # each staleness surfaced as a red gate on an unrelated pull request. The number was
        # never the property worth defending; the correspondence is, and design/20-contract.md
        # states it in both directions: "a record exists for every surface named below and for
        # nothing else". A surface entry is a ### heading under ## Public surface whose text
        # begins with a backticked path; the other headings there are prose about the section.
        $graph = Read-DesignStateGraph -Path $script:RepoRoot
        $contractText = Get-Content -LiteralPath (Join-Path $script:RepoRoot 'design/20-contract.md')

        $surfacePaths = [System.Collections.Generic.List[string]]::new()
        $inSection = $false
        foreach ($line in $contractText) {
            if ($line -match '^## Public surface\s*$') { $inSection = $true; continue }
            if ($inSection -and $line -match '^## ') { break }
            if (-not $inSection) { continue }
            if ($line -match '^### `([^`]+)`') { $surfacePaths.Add($Matches[1]) }
        }
        $surfacePaths.Count | Should -BeGreaterThan 0 -Because 'the Public-surface section must be readable at all'

        $unitByAnchor = @{}
        foreach ($unit in $graph.Records | Where-Object { $_.Kind -eq 'Unit' -and $_.Scalars['Status'] -eq 'active' }) {
            $anchor = $unit.Scalars['Anchor']
            if ($anchor) { $unitByAnchor[$anchor] = $unit.Id }
        }

        $contracts = @($graph.Records | Where-Object { $_.Kind -eq 'Contract' -and $_.Scalars['Status'] -eq 'active' })
        $ownerIds = @($contracts | ForEach-Object { $_.Scalars['Owner'] })

        # Every named surface has exactly one Contract record, owned by the unit anchored there.
        foreach ($path in $surfacePaths) {
            $unitId = $unitByAnchor[$path]
            $unitId | Should -Not -BeNullOrEmpty -Because "design/20-contract.md names $path as public surface, so an active unit must be anchored there"
            $owned = @($ownerIds | Where-Object { $_ -eq $unitId })
            $owned.Count | Should -Be 1 -Because "$path has $($owned.Count) Contract records; the section claims exactly one"
        }

        # And nothing else does - no Contract record whose owner's artifact the section does not name.
        foreach ($contract in $contracts) {
            $ownerAnchor = ($graph.Records | Where-Object { $_.Id -eq $contract.Scalars['Owner'] }).Scalars['Anchor']
            $surfacePaths | Should -Contain $ownerAnchor -Because "$($contract.Id) is owned by a unit anchored at $ownerAnchor, which design/20-contract.md's Public-surface section does not name"
        }

        (@($script:RealResult.Findings | Where-Object { $_.Class -eq 'OwnerMismatch' })).Count | Should -Be 0
    }

    It 'S16.5: design/state-index.md''s consumers region lists real consumers, not the empty-set placeholder' {
        $text = Get-Content -LiteralPath (Join-Path $script:RepoRoot 'design/state-index.md') -Raw
        $text | Should -Not -Match '_\(no contract records yet\)_'
        $text | Should -Match 'unit/command/pr'
    }

    It 'S17.2: every invariant row in the real Invariants section sits inside the single invariants region, none below it' {
        $contractPath = Join-Path $script:RepoRoot 'design/20-contract.md'
        $text = Get-Content -LiteralPath $contractPath -Raw
        $start = $text.IndexOf("`n## Invariants")
        $rest = $text.Substring($start + 1)
        $end = $rest.IndexOf("`n## ", 1)
        $section = if ($end -lt 0) { $rest } else { $rest.Substring(0, $end) }

        $regionStart = $section.IndexOf('<!-- invariants:start -->')
        $regionEnd = $section.IndexOf('<!-- invariants:end -->')
        $regionStart | Should -BeGreaterThan -1
        $regionEnd | Should -BeGreaterThan $regionStart

        $before = $section.Substring(0, $regionStart)
        $after = $section.Substring($regionEnd + '<!-- invariants:end -->'.Length)
        $rowPattern = '(?m)^\|\s*\*\*I\d+\*\*\s*\|'
        ([regex]::Matches($before, $rowPattern)).Count | Should -Be 0
        ([regex]::Matches($after, $rowPattern)).Count | Should -Be 0

        $graph = Read-DesignStateGraph -Path $script:RepoRoot
        # Active only: a retired invariant leaves the rendered table, which is the invariant unit
        # set rather than a history (design/20-contract.md, "The state set", I30).
        $recordedCount = (@($graph.Records | Where-Object { $_.Kind -eq 'Invariant' -and $_.Scalars['Status'] -eq 'active' })).Count
        $parsed = Get-ContractInvariantIds -ContractPath $contractPath
        $parsed.Ids.Count | Should -Be $recordedCount
    }

    It 'S18.6: EnforcementUnevidenced rejects this repository''s own superseded decision once its SupersededBy line is removed, and clears once it is restored' {
        $supersededPath = Join-Path $script:RepoRoot 'design/state/decisions/2026-08-03-ticking-checkbox-is-the-users.md'
        $original = Get-Content -LiteralPath $supersededPath -Raw
        $original | Should -Match '(?m)^SupersededBy:'
        try {
            $stripped = $original -replace '(?m)^SupersededBy:.*\r?\n', ''
            Set-Content -LiteralPath $supersededPath -Value $stripped -Encoding utf8NoBOM -NoNewline

            $strippedResult = Invoke-DesignStateCheck -RepoPath $script:RepoRoot
            $strippedResult.ExitCode | Should -Be 1
            $hit = @($strippedResult.Findings | Where-Object { $_.Class -eq 'EnforcementUnevidenced' -and $_.Subject -eq 'decision/2026-08-03-ticking-checkbox-is-the-users' })
            $hit.Count | Should -Be 1
            $hit[0].Detail | Should -Match 'SupersededBy'
        } finally {
            Set-Content -LiteralPath $supersededPath -Value $original -Encoding utf8NoBOM -NoNewline
        }

        # Restoring clears EnforcementUnevidenced; it does not clear ClosureOverBudget, which is
        # this repository's adjudicated state (S12.5, and design/10-design.md "Whether the
        # ceiling can be met"). Asserting exit 0 here asserted the ceiling was met.
        $restoredResult = Invoke-DesignStateCheck -RepoPath $script:RepoRoot
        (@($restoredResult.Findings | Where-Object { $_.Class -eq 'EnforcementUnevidenced' })).Count | Should -Be 0
        (@($restoredResult.Findings | Where-Object { $_.Class -notin @('ClosureOverBudget') })).Count | Should -Be 0
        (& git -C $script:RepoRoot status --short) | Should -Be $script:StatusBefore
    }
}

# =================================================================================================
# S12. The gate runs in CI, and the evidence that it constrains anything is on the record.
# =================================================================================================

Describe 'S12.2: every blocking class has fired on a real divergence and held on a near-miss' {

    BeforeAll {
        # The coverage matrix is read out of this file's own source with the PowerShell parser -
        # the same [Parser]::ParseFile the verify workflow's parse-check step uses - rather than
        # from a list kept by hand beside it. A hand-kept list is a second copy of the tag
        # inventory (AGENTS.md, Single ownership) and goes stale the first time a test is renamed
        # or deleted, which is the one thing this census exists to notice.
        $script:CensusPath = Join-Path $PSScriptRoot 'Test-DesignState.Tests.ps1'
        $censusAst = [System.Management.Automation.Language.Parser]::ParseFile($script:CensusPath, [ref]$null, [ref]$null)

        $itCalls = $censusAst.FindAll({
                param($n)
                $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'It'
            }, $true)

        $script:Fires = @{}
        $script:NearMiss = @{}
        $script:TaggedClasses = [System.Collections.Generic.SortedSet[string]]::new()

        foreach ($call in $itCalls) {
            $elements = $call.CommandElements
            for ($i = 0; $i -lt $elements.Count; $i++) {
                $element = $elements[$i]
                if ($element -isnot [System.Management.Automation.Language.CommandParameterAst]) { continue }
                if ($element.ParameterName -ne 'Tag') { continue }

                $argument = if ($element.Argument) { $element.Argument } elseif ($i + 1 -lt $elements.Count) { $elements[$i + 1] } else { $null }
                $values = @()
                if ($argument -is [System.Management.Automation.Language.ArrayLiteralAst]) {
                    $values = @($argument.Elements | ForEach-Object { $_.Value })
                } elseif ($argument) {
                    $values = @($argument.Value)
                }

                $directions = @($values | Where-Object { $_ -in 'Fires', 'NearMiss' })
                $classes = @($values | Where-Object { $_ -notin 'Fires', 'NearMiss' })
                foreach ($class in $classes) { [void]$script:TaggedClasses.Add($class) }
                foreach ($direction in $directions) {
                    $bucket = if ($direction -eq 'Fires') { $script:Fires } else { $script:NearMiss }
                    foreach ($class in $classes) {
                        if (-not $bucket.ContainsKey($class)) { $bucket[$class] = 0 }
                        $bucket[$class]++
                    }
                }
            }
        }

        $script:FiresTotal = @($script:Fires.Values | Measure-Object -Sum).Sum
        $script:NearMissTotal = @($script:NearMiss.Values | Measure-Object -Sum).Sum

        # S12.2's "the run states both counts". Written to the host so the numbers land in the CI
        # log on a green run too - a count only visible in a failure message is a count nobody
        # reads until it is already too late to be evidence of anything.
        Write-Host "S12.2 coverage over $($script:BlockingClasses.Count) blocking classes: $($script:FiresTotal) fires test(s), $($script:NearMissTotal) near-miss test(s)"
        foreach ($class in $script:BlockingClasses) {
            $f = if ($script:Fires.ContainsKey($class)) { $script:Fires[$class] } else { 0 }
            $n = if ($script:NearMiss.ContainsKey($class)) { $script:NearMiss[$class] } else { 0 }
            Write-Host ("  {0,-24} fires {1}  near-miss {2}" -f $class, $f, $n)
        }
    }

    It 'S12.2: every blocking class has at least one test that constructs a real divergence and confirms it fires' {
        $missing = @($script:BlockingClasses | Where-Object { -not $script:Fires.ContainsKey($_) })
        $missing -join ', ' | Should -BeNullOrEmpty -Because 'each of these blocking classes has no test tagged Fires, so nothing has ever seen it reject a divergence'
    }

    It 'S12.2: every blocking class has at least one test that constructs a near-miss and confirms it does not fire' {
        $missing = @($script:BlockingClasses | Where-Object { -not $script:NearMiss.ContainsKey($_) })
        $missing -join ', ' | Should -BeNullOrEmpty -Because 'each of these blocking classes has no test tagged NearMiss, so nothing bounds what it rejects'
    }

    It 'S12.2: every class tagged in this file is a blocking class the checker actually declares' {
        $unknown = @($script:TaggedClasses | Where-Object { $_ -notin $script:BlockingClasses })
        $unknown -join ', ' | Should -BeNullOrEmpty -Because 'a tag naming no real class silently under-counts the class it was meant to cover'
    }

    It 'S12.2: both counts are stated, and neither is zero' {
        $script:FiresTotal | Should -BeGreaterThan 0
        $script:NearMissTotal | Should -BeGreaterThan 0
        $script:FiresTotal | Should -BeGreaterOrEqual $script:BlockingClasses.Count
        $script:NearMissTotal | Should -BeGreaterOrEqual $script:BlockingClasses.Count
    }
}

Describe 'S12.3: a freeze permits known staleness, not a checker that could not run' {

    BeforeEach {
        Get-ChildItem $TestDrive -ErrorAction SilentlyContinue -Recurse -File |
            Remove-Item -Force -ErrorAction SilentlyContinue

        New-TreeFile -RelativePath 'design/20-contract.md' -Content $script:MinimalContract
        New-TreeFile -RelativePath 'design/90-decisions.md' -Content "# Decisions`n"
        New-TreeFile -RelativePath 'design/FROZEN.md' -Content @'
# design/ is frozen

Frozen at: abc1234, 2026-08-19
Frozen because: escaping the generative loop
Lifts when: tier one is code-complete
'@
        # A projector that runs and renders nothing. Without it ProjectorFailed fires, and the
        # run would exit 2 for a reason that has nothing to do with the freeze - which is exactly
        # the confusion the second test below exists to keep apart from the first.
        New-TreeFile -RelativePath 'tools/Update-DesignProjection.ps1' -Content 'param([string]$Path,[switch]$DryRun) exit 0'

        New-StateFile -RelativePath 'units/command/a.md' -Content @'
# unit/command/a
Kind: command
Status: active
Binds: I999
'@
    }

    It 'S12.3: with design/FROZEN.md present, no blocking class fails the build' {
        Mock Test-TrackerAvailable { $true }

        $result = Invoke-DesignStateCheck -RepoPath $TestDrive

        $result.CouldNotEvaluate.Count | Should -Be 0 -Because 'this fixture is deliberately free of could-not-evaluate, so the exit code below is the freeze''s doing and nothing else''s'
        $result.Findings.Count | Should -Be 0
        $result.DowngradedCount | Should -BeGreaterThan 0
        (@($result.Reported | Where-Object { $_.Class -eq 'UnresolvedId' })).Count | Should -Be 1
        $result.ExitCode | Should -Be 0
    }

    It 'S12.3: a could-not-evaluate still exits 2 during a freeze' {
        Mock Test-TrackerAvailable { $false }

        $result = Invoke-DesignStateCheck -RepoPath $TestDrive

        $result.Findings.Count | Should -Be 0
        $result.DowngradedCount | Should -BeGreaterThan 0
        (@($result.CouldNotEvaluate | Where-Object { $_.Reason -eq 'TrackerUnavailable' })).Count | Should -Be 1
        $result.ExitCode | Should -Be 2 -Because 'writing one file must never be a way to switch a broken checker off (I21)'
    }
}

Describe 'S12.6: a checkout with design/state/ removed' -Skip:$script:SkipDesignStateSelfTests {

    BeforeAll {
        # A real copy of this repository, minus design/state/ - the shape every installed target
        # has by construction, since nothing under the kit's own design/ is on INSTALL.md's
        # artifact list. Built from the tree rather than from a fixture so that "the state set is
        # absent" is asserted against a checkout that is otherwise complete. Requires this repo to
        # itself have design/state/ to strip - guarded by $script:SkipDesignStateSelfTests same as
        # the "against this repository's own tree" block above.
        $script:S12RepoRoot = Split-Path $PSScriptRoot -Parent
        $script:S12Checkout = Join-Path $TestDrive 'checkout-without-state'
        New-Item -ItemType Directory -Path $script:S12Checkout -Force | Out-Null
        Get-ChildItem -LiteralPath $script:S12RepoRoot -Force |
            Where-Object { $_.Name -ne '.git' } |
            Copy-Item -Destination $script:S12Checkout -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $script:S12Checkout 'design/state') -Recurse -Force

        $script:S12Result = Invoke-DesignStateCheck -RepoPath $script:S12Checkout
    }

    It 'S12.6: exits 2 reporting StateSetAbsent' {
        (@($script:S12Result.CouldNotEvaluate | Where-Object { $_.Reason -eq 'StateSetAbsent' })).Count | Should -Be 1
        $script:S12Result.ExitCode | Should -Be 2
    }

    It 'S12.6: and never 0' {
        $script:S12Result.ExitCode | Should -Not -Be 0
        $script:S12Result.Findings.Count | Should -Be 0 -Because 'absence of a finding is not a finding of absence (I8''s shape, I19)'
    }
}

Describe 'S12.7: an installed target discovers these suites as skipped, not failed' -Skip:$script:SkipDesignStateSelfTests {

    BeforeAll {
        # The regression guard for the -Skip: conditions at the top of this file and of
        # Read-DesignState.Tests.ps1, Update-DesignProjection.Tests.ps1 and Test-CIWorkflow.Tests.ps1.
        # Remove any of them and this block fails. The fixture is S12.6's shape - a real copy of
        # this repository minus adopted design state, with the work mirror that /track creates,
        # plus the one line that makes verify.yml look like an installed target's: no "Check the
        # design state against the tree" step.
        $script:S127RepoRoot = Split-Path $PSScriptRoot -Parent
        $script:S127Checkout = Join-Path $TestDrive 'checkout-target-shaped'
        New-Item -ItemType Directory -Path $script:S127Checkout -Force | Out-Null
        Get-ChildItem -LiteralPath $script:S127RepoRoot -Force |
            Where-Object { $_.Name -ne '.git' } |
            Copy-Item -Destination $script:S127Checkout -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $script:S127Checkout 'design/state') -Recurse -Force
        New-Item -ItemType Directory -Path (Join-Path $script:S127Checkout 'design/state/work') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:S127Checkout 'design/state/work/1.md') -Encoding utf8NoBOM -Value @'
# work/1
Issue: 1
Title: x
State: OPEN
Rank: 1
MirroredAt: abc123
Criteria:
'@

        $script:S127Workflow = Join-Path $script:S127Checkout '.github/workflows/verify.yml'
        @(Get-Content -LiteralPath $script:S127Workflow) |
            Where-Object { $_ -notmatch '- name: Check the design state against the tree' } |
            Set-Content -LiteralPath $script:S127Workflow -Encoding utf8NoBOM

        # Discovery alone answers this: -Skip: is evaluated during Pester's discovery pass, so
        # nothing here runs 139 tests inside one test. It runs in a child process rather than a
        # nested Invoke-Pester because Pester keeps run state in the session.
        $script:S127Runner = Join-Path $TestDrive 'discover-skips.ps1'
        Set-Content -LiteralPath $script:S127Runner -Encoding utf8NoBOM -Value @'
param([Parameter(Mandatory)][string] $Root)
$c = New-PesterConfiguration
$c.Run.Path = @(
    (Join-Path $Root 'tools/Read-DesignState.Tests.ps1'),
    (Join-Path $Root 'tools/Test-CIWorkflow.Tests.ps1'),
    (Join-Path $Root 'tools/Test-DesignState.Tests.ps1'),
    (Join-Path $Root 'tools/Update-DesignProjection.Tests.ps1'))
$c.Run.PassThru = $true
$c.Run.SkipRun = $true
$c.Output.Verbosity = 'None'
$r = Invoke-Pester -Configuration $c
@($r.Tests | ForEach-Object {
    [pscustomobject]@{ Block = $_.Block.Name; Name = $_.Name; Skip = [bool]$_.Skip }
}) | ConvertTo-Json -Depth 3 -Compress
'@

        function Get-DiscoveredSkip {
            param([Parameter(Mandatory)][string] $Root)
            # The suites emit a coverage summary during discovery, so take the JSON line only.
            $output = & pwsh -NoProfile -File $script:S127Runner -Root $Root
            $json = @($output | Where-Object { $_ -is [string] -and $_.TrimStart().StartsWith('[') }) |
                Select-Object -Last 1
            $json | Should -Not -BeNullOrEmpty -Because 'discovery must produce a result to assert on'
            $json | ConvertFrom-Json
        }

        $script:S127SelfReferentialBlocks = @(
            "Read-DesignState against this repository's own state set",
            "Test-DesignState against this repository's own tree",
            'S12.6: a checkout with design/state/ removed',
            "Update-DesignProjection against this repository's own tree")
        $script:S127GlobTest = "this repository's own table and its own enumeration agree"
        $script:S127CIBlock = 'CI workflow: the Run Pester tests step is authenticated (#79)'

        $script:S127Target = Get-DiscoveredSkip -Root $script:S127Checkout
        $script:S127Here = Get-DiscoveredSkip -Root $script:S127RepoRoot
    }

    It 'S12.7: every self-referential block is skipped where only work-mirror state exists' {
        foreach ($block in $script:S127SelfReferentialBlocks) {
            $tests = @($script:S127Target | Where-Object { $_.Block -eq $block })
            $tests.Count | Should -BeGreaterThan 0 -Because "$block must still be discovered - skipped, not deleted"
            @($tests | Where-Object { -not $_.Skip }).Count |
                Should -Be 0 -Because "$block asserts on adopted design-state content an installed target does not have"
        }

        $glob = @($script:S127Target | Where-Object { $_.Name -eq $script:S127GlobTest })
        $glob.Count | Should -Be 1
        $glob[0].Skip | Should -BeTrue
    }

    It 'S12.7: the #79 CI comparison is skipped where verify.yml carries no design-state step' {
        $tests = @($script:S127Target | Where-Object { $_.Block -eq $script:S127CIBlock })
        $tests.Count | Should -BeGreaterThan 0
        @($tests | Where-Object { -not $_.Skip }).Count |
            Should -Be 0 -Because 'there is no second step to compare the GH_TOKEN env against'
    }

    It 'S12.7: and none of them are skipped in this repository, which has both' {
        $guarded = @($script:S127Here | Where-Object {
            $_.Block -in $script:S127SelfReferentialBlocks -or
            $_.Block -eq $script:S127CIBlock -or
            $_.Name -eq $script:S127GlobTest
        })
        $guarded.Count | Should -BeGreaterThan 0
        @($guarded | Where-Object { $_.Skip }).Count |
            Should -Be 0 -Because 'the guards must be false here, or they would silence the coverage this repository relies on'
    }
}
