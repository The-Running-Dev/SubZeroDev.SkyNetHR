#Requires -Version 7.0
<#
.SYNOPSIS
    Reads design/state/ into a graph. Never throws, never writes, never skips a line.

.DESCRIPTION
    The state set (design/20-contract.md § Persisted schemas) is constrained Markdown: one
    record per file, an H1 naming the id, scalar and list fields as colon lines, prose fields
    as `## Field` sections. This is the one place that grammar is read. A line matching no
    production is a parse failure (I24) - reported with its file, line number, and verbatim
    text - never dropped and never a terminating error, because a caller that got an exception
    would lose every record that did parse, which is the part a report is made of.

    A record's kind - Unit, Invariant, Contract, Decision, Question, WorkRef - is read from
    which directory under design/state/ the file lives in, per the id-to-path table in
    design/20-contract.md. Each kind has its own closed field vocabulary; a name outside it -
    including the derived-edge names Consumers, BoundBy and Affects (I17) - matches no
    production and is reported the same as any other unrecognised line.

    A record's own H1 id is taken literally, even when it disagrees with the id the file's path
    implies (S4.7) - the graph carries both, because the path is already in memory and the
    id-to-path mapping recovers the path-implied id from it without a second read. Which of the
    two is wrong is the graph validator's call, not the reader's.

    Reads only. Writes nothing, ever (I18). An absent design/state/ is a graph with an empty
    Root and zero records, not an error - deciding what absence means belongs to the checker,
    not the reader.

.PARAMETER Path
    Repository root. design/state/ is resolved beneath it. Defaults to the current directory.

.EXAMPLE
    ./tools/Read-DesignState.ps1

.EXAMPLE
    $graph = . ./tools/Read-DesignState.ps1 -Path 'unused'; Read-DesignStateGraph -Path $repo
#>
[CmdletBinding()]
param(
    [string] $Path = (Get-Location).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-DesignRecord {
    <#
        CompanionPath and FieldOrigin are meaningful only for a Kind 'Unit' record, and only
        since the retired companion landed (design/20-contract.md, "A unit is one record in two
        files"): CompanionPath is the retired companion's relative path when one exists, and
        FieldOrigin maps each field name actually present on the joined record to the file it
        was read from ('Active' or 'Companion') - RecordPairMalformed's own evidence, since a
        field placed in the wrong file still parses under the one Unit vocabulary and needs
        this to be told apart from a correctly-placed one. Every other kind leaves both at
        their defaults.
    #>
    param(
        [Parameter(Mandatory)][string]   $Id,
        [Parameter(Mandatory)][string]   $Kind,
        [Parameter(Mandatory)][string]   $Path,
        [Parameter(Mandatory)][hashtable] $Scalars,
        [Parameter(Mandatory)][hashtable] $Lists,
        [Parameter(Mandatory)][hashtable] $Prose,
        [string]    $CompanionPath = $null,
        [hashtable] $FieldOrigin   = @{}
    )
    [pscustomobject]@{
        Id            = $Id
        Kind          = $Kind
        Path          = $Path
        CompanionPath = $CompanionPath
        Scalars       = $Scalars
        Lists         = $Lists
        Prose         = $Prose
        FieldOrigin   = $FieldOrigin
    }
}

function New-DesignStateGraph {
    <#
        CompanionOnly carries a retired-companion file that has no active record beside it -
        design/20-contract.md's "a companion with no active record beside it" shape of
        RecordPairMalformed. It is never folded into Records: the companion is not a second
        record (design/10-design.md, "A unit is one record in two files"), so there is nothing
        well-formed to build one from.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]       $Root,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Records,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Failures,
        [AllowEmptyCollection()][object[]] $CompanionOnly = @()
    )
    [pscustomobject]@{
        Root          = $Root
        Records       = @($Records)
        Failures      = @($Failures)
        CompanionOnly = @($CompanionOnly)
    }
}

function New-DesignStateFailure {
    param(
        [Parameter(Mandatory)][string] $Reason,
        [Parameter(Mandatory)][string] $Path,
        [int]    $Line,
        [string] $Text
    )
    [pscustomobject]@{
        Reason = $Reason
        Path   = $Path
        Line   = $Line
        Text   = $Text
    }
}

<#
    One closed vocabulary per top-level kind, built from design/10-design.md § Data model. An
    Invariant record specialises the Unit fields on the same record (design/20-contract.md,
    "A unit of kind invariant is one record, not two"), so its table is the Unit table plus
    Owner, Enforcement and Statement rather than a fresh one.

    Consumers, BoundBy and Affects are deliberately absent from every table - they are derived
    reverse edges and design/10-design.md is explicit that writing one is forbidden (I17). Their
    absence here, not a denylist checked separately, is what makes them fail the same way any
    other unrecognised field would.
#>
#
# The four unit kinds (design/10-design.md § Unit) - used to validate the <kind> path segment
# under design/state/units/, for both the active (3-segment) and companion (4-segment, retired/)
# shapes alike (design/20-contract.md, S20.3). 'invariant' is a legal value here even though no
# unit of that kind is ever persisted under units/ today - invariant records live under the
# separate design/state/invariants/ scheme and never gain a companion (S20's Out of scope) - the
# set is the Kind scalar's own vocabulary, not a survey of what the checkout currently holds.
#
$script:UnitKinds = @('command', 'script', 'document', 'invariant')

$script:FieldTables = @{
    Unit      = @{
        Scalar = @('Kind', 'Status', 'Anchor')
        List   = @(
            # Active-half fields (design/10-design.md § Unit's active-record table).
            'Consumes', 'Exposes', 'Binds', 'Live', 'Questions', 'Work', 'Evidence',
            # Companion-half fields (same section's retired-companion table). Recognised here so
            # the grammar accepts them wherever they appear - which file each one belongs in is
            # a pairing rule the checker enforces (RecordPairMalformed), not a second field table
            # (design/20-contract.md, "A unit is one record in two files").
            'Consumed', 'Exposed', 'Bound', 'Archival', 'Answered', 'Worked'
        )
        Prose  = @('Owns')
    }
    Invariant = @{
        Scalar = @('Kind', 'Status', 'Anchor', 'Owner', 'Enforcement')
        List   = @('Consumes', 'Exposes', 'Binds', 'Live', 'Archival', 'Questions', 'Work', 'Evidence')
        Prose  = @('Statement')
    }
    Contract  = @{
        Scalar = @('Status', 'Owner', 'Declaration')
        List   = @()
        Prose  = @('Semantics')
    }
    Decision  = @{
        Scalar = @('Date', 'Anchor', 'Status', 'SupersededBy')
        List   = @('StatedIn')
        Prose  = @('Claim')
    }
    Question  = @{
        Scalar = @('Status', 'AnsweredBy')
        List   = @()
        Prose  = @('Text')
    }
    WorkRef   = @{
        Scalar = @('Issue', 'Title', 'State', 'Rank', 'MirroredAt')
        List   = @('Criteria')
        Prose  = @()
    }
}

<#
    Maps a file's path relative to design/state/ to its top-level kind and the id its path
    implies, per the table in design/20-contract.md § Persisted schemas. Returns $null for a
    location the table does not name - the caller reports that as a parse failure rather than
    guessing a kind for it.

    'units' carries two shapes now: units/<kind>/<slug>.md (the active record, IsCompanion
    $false) and units/<kind>/retired/<slug>.md (its companion, IsCompanion $true) - both resolve
    to the same PathId, which is what lets the caller join them. <kind> is validated against
    $script:UnitKinds in both shapes, so units/retired/<slug>.md - where 'retired' would
    otherwise be read as the kind - is a parse failure naming a kind that is not one, and
    'retired' never resolves as a kind (design/20-contract.md, S20.3).
#>
function Get-DesignPathInfo {
    param([Parameter(Mandatory)][string] $RelativeToState)

    $parts = @($RelativeToState -split '[\\/]')
    switch ($parts[0]) {
        'units' {
            if ($parts.Count -eq 3) {
                $kind = $parts[1]
                if ($script:UnitKinds -notcontains $kind) { return $null }
                return [pscustomobject]@{
                    Kind        = 'Unit'
                    PathId      = "unit/$kind/$([IO.Path]::GetFileNameWithoutExtension($parts[2]))"
                    IsCompanion = $false
                }
            }
            if ($parts.Count -eq 4 -and $parts[2] -eq 'retired') {
                $kind = $parts[1]
                if ($script:UnitKinds -notcontains $kind) { return $null }
                return [pscustomobject]@{
                    Kind        = 'Unit'
                    PathId      = "unit/$kind/$([IO.Path]::GetFileNameWithoutExtension($parts[3]))"
                    IsCompanion = $true
                }
            }
            return $null
        }
        'invariants' {
            if ($parts.Count -ne 2) { return $null }
            [pscustomobject]@{ Kind = 'Invariant'; PathId = [IO.Path]::GetFileNameWithoutExtension($parts[1]); IsCompanion = $false }
        }
        'contracts' {
            if ($parts.Count -ne 2) { return $null }
            [pscustomobject]@{ Kind = 'Contract'; PathId = "contract/$([IO.Path]::GetFileNameWithoutExtension($parts[1]))"; IsCompanion = $false }
        }
        'decisions' {
            if ($parts.Count -ne 2) { return $null }
            [pscustomobject]@{ Kind = 'Decision'; PathId = "decision/$([IO.Path]::GetFileNameWithoutExtension($parts[1]))"; IsCompanion = $false }
        }
        'questions' {
            if ($parts.Count -ne 2) { return $null }
            [pscustomobject]@{ Kind = 'Question'; PathId = "question/$([IO.Path]::GetFileNameWithoutExtension($parts[1]))"; IsCompanion = $false }
        }
        'work' {
            if ($parts.Count -ne 2) { return $null }
            [pscustomobject]@{ Kind = 'WorkRef'; PathId = "work/$([IO.Path]::GetFileNameWithoutExtension($parts[1]))"; IsCompanion = $false }
        }
        default { $null }
    }
}

<#
    The field-line grammar shared by an active record file (which parses it after an H1) and a
    retired companion file (which has no H1 and parses it from line 1 - design/20-contract.md,
    "the retired companion... carries no Id line and has no id of its own"). Extracted out of
    Read-DesignRecordFile so the two callers below cannot drift into two grammars for one Unit
    vocabulary. Returns @{ Scalars; Lists; Prose; Failures }.
#>
function Split-DesignListValue {
    <#
        Splits a list field's raw value into entries on `,`, except inside a double-quoted
        entry - whose quotes are stripped - so a StatedIn site can name a heading that contains
        the separator (design/90-decisions.md, 2026-09-02 "A list entry may be quoted..."). The
        rule is one grammar for every list field, not a StatedIn-only form. There is no escape:
        a double quote anywhere other than as the pair delimiting a whole entry - an unterminated
        quote, or one embedded inside an otherwise-unquoted entry - is malformed, and the caller
        reports the whole field line as Unparseable, the same as any other grammar failure here.
    #>
    param([Parameter(Mandatory)][AllowEmptyString()][string] $Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return @{ Entries = @(); Malformed = $false } }

    $entries = [System.Collections.Generic.List[string]]::new()
    $pattern = '^\s*(?:"([^"]*)"|([^",]*))\s*(?:,|$)'
    $remaining = $Value
    while ($remaining.Length -gt 0) {
        $m = [regex]::Match($remaining, $pattern)
        if (-not $m.Success) { return @{ Entries = @($entries); Malformed = $true } }
        if ($m.Groups[1].Success) {
            $entries.Add($m.Groups[1].Value)
        } else {
            $entries.Add($m.Groups[2].Value.Trim())
        }
        $remaining = $remaining.Substring($m.Length)
    }
    @{ Entries = @($entries); Malformed = $false }
}

function Read-DesignFieldBlock {
    param(
        # AllowEmptyString alongside AllowEmptyCollection: PowerShell's [string[]] binder rejects
        # an otherwise non-empty array whose last element is '' ("...because it is an empty
        # string") unless both are present - Get-Content routinely produces exactly that shape
        # for a file ending in a newline, so this is not optional.
        [Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]] $Lines,
        [Parameter(Mandatory)][int] $StartIndex,
        [Parameter(Mandatory)][string] $RelativePath,
        [Parameter(Mandatory)][hashtable] $Table
    )

    $failures = [System.Collections.Generic.List[object]]::new()
    $scalars = @{}
    $lists = @{}
    $prose = @{}
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $pastFirstHash = $false
    $currentProseField = $null
    $proseBody = [System.Collections.Generic.List[string]]::new()

    function Test-KnownField {
        param([string] $Name)
        $Table.Scalar -contains $Name -or $Table.List -contains $Name -or $Table.Prose -contains $Name
    }

    function Close-ProseSection {
        if ($currentProseField) {
            $prose[$currentProseField] = ($proseBody -join "`n").TrimEnd()
        }
    }

    for ($i = $StartIndex; $i -lt $Lines.Count; $i++) {
        $line = $Lines[$i]
        $lineNumber = $i + 1

        if (-not $pastFirstHash) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }

            if ($line -match '^##\s+(\S+)\s*$') {
                $name = $Matches[1]
                $pastFirstHash = $true
                if (-not ($Table.Prose -contains $name)) {
                    $failures.Add((New-DesignStateFailure -Reason 'Unparseable' -Path $RelativePath -Line $lineNumber -Text $line))
                    $currentProseField = $null
                    continue
                }
                if ($seen.Contains($name)) {
                    $failures.Add((New-DesignStateFailure -Reason 'DuplicateField' -Path $RelativePath -Line $lineNumber -Text $line))
                    $currentProseField = $null
                    continue
                }
                [void]$seen.Add($name)
                $currentProseField = $name
                $proseBody = [System.Collections.Generic.List[string]]::new()
                continue
            }

            if ($line -match '^([A-Za-z]+):(.*)$') {
                $name = $Matches[1]
                $value = $Matches[2].TrimStart()

                if (-not (Test-KnownField -Name $name)) {
                    $failures.Add((New-DesignStateFailure -Reason 'Unparseable' -Path $RelativePath -Line $lineNumber -Text $line))
                    continue
                }
                if ($seen.Contains($name)) {
                    $failures.Add((New-DesignStateFailure -Reason 'DuplicateField' -Path $RelativePath -Line $lineNumber -Text $line))
                    continue
                }
                if ($Table.Prose -contains $name) {
                    # A prose field written as a colon line is not the `## Field` production.
                    $failures.Add((New-DesignStateFailure -Reason 'Unparseable' -Path $RelativePath -Line $lineNumber -Text $line))
                    continue
                }

                [void]$seen.Add($name)
                if ($Table.List -contains $name) {
                    $split = Split-DesignListValue -Value $value
                    if ($split.Malformed) {
                        $failures.Add((New-DesignStateFailure -Reason 'Unparseable' -Path $RelativePath -Line $lineNumber -Text $line))
                        continue
                    }
                    $rawEntries = $split.Entries
                    if ($name -eq 'StatedIn') {
                        # design/20-contract.md § "The state set": each site is `<id> § <heading>`.
                        # An entry not of that form is a parse failure (S21.1) - reported with the
                        # whole field line, per New-DesignStateFailure's own rule that the offending
                        # line is reproduced verbatim rather than described - and never silently
                        # dropped from the failure list, even though it is dropped from the parsed
                        # list so a malformed site cannot masquerade as a resolvable one.
                        $validEntries = [System.Collections.Generic.List[string]]::new()
                        foreach ($entry in $rawEntries) {
                            if ($entry -match '^\S+ § .+$') {
                                $validEntries.Add($entry)
                            } else {
                                $failures.Add((New-DesignStateFailure -Reason 'Unparseable' -Path $RelativePath -Line $lineNumber -Text $line))
                            }
                        }
                        $lists[$name] = @($validEntries)
                    }
                    else {
                        $lists[$name] = $rawEntries
                    }
                }
                else {
                    $scalars[$name] = $value
                }
                continue
            }

            $failures.Add((New-DesignStateFailure -Reason 'Unparseable' -Path $RelativePath -Line $lineNumber -Text $line))
            continue
        }

        # Past the first `##`: only a new `## Field` header re-enters field territory. Anything
        # else is prose body, except a line that reuses a known field name in colon form - that
        # is a field line arriving too late (S4.8), not a coincidence of free Markdown.
        if ($line -match '^##\s+(\S+)\s*$') {
            Close-ProseSection
            $name = $Matches[1]
            if (-not ($Table.Prose -contains $name)) {
                $failures.Add((New-DesignStateFailure -Reason 'Unparseable' -Path $RelativePath -Line $lineNumber -Text $line))
                $currentProseField = $null
                continue
            }
            if ($seen.Contains($name)) {
                $failures.Add((New-DesignStateFailure -Reason 'DuplicateField' -Path $RelativePath -Line $lineNumber -Text $line))
                $currentProseField = $null
                continue
            }
            [void]$seen.Add($name)
            $currentProseField = $name
            $proseBody = [System.Collections.Generic.List[string]]::new()
            continue
        }

        if ($line -match '^([A-Za-z]+):(.*)$' -and (Test-KnownField -Name $Matches[1])) {
            $failures.Add((New-DesignStateFailure -Reason 'LateField' -Path $RelativePath -Line $lineNumber -Text $line))
            continue
        }

        if ($currentProseField) { $proseBody.Add($line) }
    }
    Close-ProseSection

    @{ Scalars = $scalars; Lists = $lists; Prose = $prose; Failures = @($failures) }
}

<#
    Parses one active record file. Returns @{ Record = <record-or-$null>; Failures = <failure[]> }.

    Two passes over "no valid production": if the first non-blank line is not a well-formed H1,
    nothing in the file can be attributed to a record - there is no id to build one under - so
    every non-blank line is reported and no Record is returned (S4.2's "every line malformed"
    shape). Once the H1 parses, every remaining line is matched against the field grammar for
    this file's kind and reported individually on failure; the record built from what did parse
    is still returned, because a malformed line elsewhere must not cost the ones that were fine.
#>
function Read-DesignRecordFile {
    param(
        [Parameter(Mandatory)][string] $FullPath,
        [Parameter(Mandatory)][string] $RelativePath,
        [Parameter(Mandatory)][string] $Kind
    )

    $failures = [System.Collections.Generic.List[object]]::new()
    $lines = @(Get-Content -LiteralPath $FullPath)
    $table = $script:FieldTables[$Kind]

    # Find the first non-blank line and test it as the H1 production.
    $firstIndex = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if (-not [string]::IsNullOrWhiteSpace($lines[$i])) { $firstIndex = $i; break }
    }

    if ($firstIndex -lt 0) {
        # An empty (or all-blank) file names no id and carries no content to report as a failure.
        return @{ Record = $null; Failures = @() }
    }

    $id = $null
    if ($lines[$firstIndex] -match '^#\s+(\S+)\s*$') {
        $id = $Matches[1]
    }

    if (-not $id) {
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ([string]::IsNullOrWhiteSpace($lines[$i])) { continue }
            $failures.Add((New-DesignStateFailure -Reason 'Unparseable' -Path $RelativePath -Line ($i + 1) -Text $lines[$i]))
        }
        return @{ Record = $null; Failures = @($failures) }
    }

    $parsed = Read-DesignFieldBlock -Lines $lines -StartIndex ($firstIndex + 1) -RelativePath $RelativePath -Table $table
    $failures.AddRange($parsed.Failures)

    $record = New-DesignRecord -Id $id -Kind $Kind -Path $RelativePath -Scalars $parsed.Scalars -Lists $parsed.Lists -Prose $parsed.Prose
    @{ Record = $record; Failures = @($failures) }
}

<#
    Parses one retired companion file. No H1, no id of its own (design/20-contract.md, "its
    identity is entirely positional - the unit whose slug it shares, one directory up") - field
    lines are read from the top of the file under the same Unit vocabulary Read-DesignRecordFile
    uses for the active half. Returns @{ Scalars; Lists; Prose; Failures } - never a Record,
    because a companion is not a record (design/10-design.md, "A unit is one record in two
    files").
#>
function Read-DesignCompanionFile {
    param(
        [Parameter(Mandatory)][string] $FullPath,
        [Parameter(Mandatory)][string] $RelativePath
    )

    $lines = @(Get-Content -LiteralPath $FullPath)
    Read-DesignFieldBlock -Lines $lines -StartIndex 0 -RelativePath $RelativePath -Table $script:FieldTables['Unit']
}

function Read-DesignStateGraph {
    <#
        Every non-Unit file parses exactly as before: one file, one record. A Unit file is
        different in kind, not just in path - it is one half of a pair, so the two passes below
        collect every active and every companion parse by PathId first and join them only once
        every file has been read. That ordering is what lets a companion whose active file
        appears later in the sorted walk still join correctly, and what lets an orphaned
        companion (no active file at all) surface as CompanionOnly instead of being silently
        dropped.
    #>
    param([Parameter(Mandatory)][string] $Path)

    $stateDir = Join-Path $Path 'design/state'
    if (-not (Test-Path -LiteralPath $stateDir -PathType Container)) {
        return New-DesignStateGraph -Root '' -Records @() -Failures @()
    }

    $records = [System.Collections.Generic.List[object]]::new()
    $failures = [System.Collections.Generic.List[object]]::new()
    $activeUnits = @{}    # PathId -> @{ Path; Record }
    $companionUnits = @{} # PathId -> @{ Path; Scalars; Lists; Prose }

    $files = @(Get-ChildItem -LiteralPath $stateDir -Recurse -File -Filter '*.md' | Sort-Object FullName)
    foreach ($file in $files) {
        $relFromState = $file.FullName.Substring($stateDir.Length + 1) -replace '\\', '/'
        $relPath = "design/state/$relFromState"

        $info = Get-DesignPathInfo -RelativeToState $relFromState
        if (-not $info) {
            $failures.Add((New-DesignStateFailure -Reason 'UnrecognisedLocation' -Path $relPath))
            continue
        }

        if ($info.Kind -eq 'Unit' -and $info.IsCompanion) {
            $parsed = Read-DesignCompanionFile -FullPath $file.FullName -RelativePath $relPath
            foreach ($f in $parsed.Failures) { $failures.Add($f) }
            $companionUnits[$info.PathId] = @{ Path = $relPath; Scalars = $parsed.Scalars; Lists = $parsed.Lists; Prose = $parsed.Prose }
            continue
        }

        $parsed = Read-DesignRecordFile -FullPath $file.FullName -RelativePath $relPath -Kind $info.Kind
        foreach ($f in $parsed.Failures) { $failures.Add($f) }
        if (-not $parsed.Record) { continue }

        if ($info.Kind -eq 'Unit') {
            $activeUnits[$info.PathId] = @{ Path = $relPath; Record = $parsed.Record }
            continue
        }

        $records.Add($parsed.Record)
    }

    foreach ($pathId in $activeUnits.Keys) {
        $active = $activeUnits[$pathId]
        $companion = if ($companionUnits.ContainsKey($pathId)) { $companionUnits[$pathId] } else { $null }

        $lists = @{}
        $fieldOrigin = @{}
        foreach ($k in $active.Record.Scalars.Keys) { $fieldOrigin[$k] = 'Active' }
        foreach ($k in $active.Record.Lists.Keys) { $lists[$k] = $active.Record.Lists[$k]; $fieldOrigin[$k] = 'Active' }
        foreach ($k in $active.Record.Prose.Keys) { $fieldOrigin[$k] = 'Active' }
        if ($companion) {
            # A companion's own Scalars/Prose - always empty in a well-formed one - are tracked
            # via FieldOrigin only, for RecordPairMalformed to name; they are not merged into the
            # joined record, which the grammar never treats as authoritative for them anyway.
            foreach ($k in $companion.Scalars.Keys) { $fieldOrigin[$k] = 'Companion' }
            foreach ($k in $companion.Lists.Keys) { $lists[$k] = $companion.Lists[$k]; $fieldOrigin[$k] = 'Companion' }
            foreach ($k in $companion.Prose.Keys) { $fieldOrigin[$k] = 'Companion' }
        }

        $companionPath = if ($companion) { $companion.Path } else { $null }
        $joined = New-DesignRecord -Id $active.Record.Id -Kind 'Unit' -Path $active.Path `
            -Scalars $active.Record.Scalars -Lists $lists -Prose $active.Record.Prose `
            -CompanionPath $companionPath -FieldOrigin $fieldOrigin
        $records.Add($joined)
    }

    $companionOnly = [System.Collections.Generic.List[object]]::new()
    foreach ($pathId in $companionUnits.Keys) {
        if (-not $activeUnits.ContainsKey($pathId)) {
            $companionOnly.Add([pscustomobject]@{ Id = $pathId; Path = $companionUnits[$pathId].Path })
        }
    }

    New-DesignStateGraph -Root $stateDir -Records @($records) -Failures @($failures) -CompanionOnly @($companionOnly)
}

# Guards the invocation so this script's tests can dot-source it instead - that defines every
# function above in the caller's scope and skips straight past this block, the same shape
# Test-DesignDrift.ps1 and Wait-PullRequestCheck.ps1 already use.
if ($MyInvocation.InvocationName -ne '.') {
    Read-DesignStateGraph -Path $Path
}
