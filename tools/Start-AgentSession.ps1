#Requires -Version 7.0
<#
.SYNOPSIS
    Launches the right agent session for a kit command, and refuses to carry a
    session across a boundary that AGENTS.md says must not be carried.

.DESCRIPTION
    Three jobs, in order of how much they are worth:

    1. Routing. AGENTS.md § Command routing says which model family and effort
       each command needs. That table is transcribed here once, so the model is
       chosen by the command rather than by whatever session happened to be open.

    2. Session boundaries. AGENTS.md § Session boundaries says which stages must
       start fresh and which must stay in the same session. Only two chains are
       same-session - slice -> verify -> pr -> resolve, and the same tail after
       fix. Everything else is fresh, and asking to continue across a fresh
       boundary is a hard stop rather than a warning.

    3. Launching. It starts the session with those parameters, in the project
       directory, and records the session id so the next command in a chain can
       resume it instead of guessing.

    What it does NOT do is run the next command for you. A boundary exists
    because a session must end; a script that starts the next one has removed
    the boundary it just announced.

    Remote, verified against the installed CLIs rather than assumed. Claude
    Code's remote flags are registered with .hideHelp(), so `claude --help` does
    not list them and probing for subcommands finds nothing; they were confirmed
    by reading the CLI bundle and by `claude --remote` reporting a missing
    argument rather than an unknown option.

      Verb       claude 2.1.12                   codex 0.146.0
      ---------  ------------------------------  ---------------------------
      Create     claude --remote "<description>" codex cloud exec "<desc>"
      List       claude --teleport (picker)      codex cloud list
      Teleport   claude --teleport <id>          codex cloud apply <id>
      Start      n/a - no daemon                 codex remote-control start
      Stop       n/a                             codex remote-control stop
      Pair       n/a                             codex remote-control pair

    Create makes a session that the desktop app and claude.ai/code list and
    manage; Teleport pulls one back down to this checkout. Start/Stop/Pair are
    Codex-only because only Codex runs a local app-server daemon for the Desktop
    app to attach to - Claude Code has no equivalent to enable, which is a
    difference in architecture rather than a gap in this script.

    claude --teleport refuses on a dirty worktree and refuses from the wrong
    repository. Both are checked here before launching, because finding out
    after a Sessions API round trip costs more than a `git status`.

    Effort is asymmetric too. Codex takes model_reasoning_effort as config.
    Claude Code has no CLI effort flag at all, so the tier is carried in the
    banner - which is what AGENTS.md asks for anyway: the session scales its own
    reasoning depth, and the banner is the instruction it reads.

.PARAMETER Command
    Kit command to run, without the leading slash. Sets model, effort, and the
    boundary rule. See Get-RoutingTable below for the transcribed table.

.PARAMETER Argument
    Argument appended to the command, e.g. -Command slice -Argument S4 becomes
    the prompt "/slice S4".

.PARAMETER Prompt
    Free-text prompt for work that is not a kit command. Requires -Tier, because
    the routing table is the only thing that would otherwise pick a model, and
    guessing a tier is the failure this script exists to prevent.

.PARAMETER Tier
    Tier for -Prompt. Deep, Implementation, or HighVolume, per AGENTS.md
    § Model, effort, and review budget.

.PARAMETER Vendor
    claude, codex, or auto. Default auto resolves to claude, except for redteam,
    where AGENTS.md requires a different vendor from the design author and this
    picks the opposite of whoever last wrote a design artifact.

.PARAMETER Project
    Repository to work in. Defaults to the current directory. Resolved to the
    git top level so state is keyed on the repository, not on a subdirectory.

.PARAMETER Effort
    Override the table's effort. max is never selected by the table and only
    ever reached by naming it here, per AGENTS.md.

.PARAMETER Escalate
    Bump effort one notch, capped at xhigh. The "exceptional fork" case: one
    specific question that stayed ambiguous at the table's effort.

.PARAMETER Continue
    Resume the recorded session instead of starting a fresh one. Valid only
    inside a same-session chain. Across a fresh boundary this is a hard stop,
    overridable only with -Force, and -Force prints what is being overridden.

.PARAMETER Desktop
    Open in the Desktop app instead of a terminal. Real for codex
    (`codex app <path>`); for claude there is no verified CLI entry point, so it
    reports that and falls back to a terminal.

.PARAMETER DryRun
    Print the banner and emit the launch plan as an object. Launches nothing.

.PARAMETER Remote
    Remote session verb: Create, List, Teleport, Start, Stop, or Pair. See the
    table above for what each maps to per vendor. Create and Teleport are the
    two that exist on both; Start, Stop, and Pair are Codex daemon control.

.PARAMETER Description
    Description for -Remote Create. Required, and required to be written rather
    than derived: it is the title the session is listed under in the desktop
    app, and an auto-generated one makes a list of sessions unreadable.

.PARAMETER SessionId
    Session to act on for -Remote Teleport. Omit for claude to get the
    interactive picker; required for codex, whose cloud apply takes an id.

.PARAMETER Status
    Report recorded state, the boundary the next command faces, and the session
    ids this project has on disk for both vendors.

.PARAMETER Force
    Override a boundary refusal. Prints what is being overridden.

.PARAMETER StatePath
    State file location. Defaults to
    $env:LOCALAPPDATA/SubZeroDev.AgentKit/sessions/<repo-slug>.json. Kept out of
    the repository on purpose: it is machine state, and a state file inside a
    repository is a state file that eventually gets committed.

.EXAMPLE
    ./tools/Start-AgentSession.ps1 -Command design

.EXAMPLE
    ./tools/Start-AgentSession.ps1 -Command redteam
    # -Vendor auto sends this to codex, because claude wrote the design.

.EXAMPLE
    ./tools/Start-AgentSession.ps1 -Command slice -Argument S4
    ./tools/Start-AgentSession.ps1 -Command verify -Continue
    ./tools/Start-AgentSession.ps1 -Command pr -Continue

.EXAMPLE
    # Kick work off remotely, carry on elsewhere, pull it back down here.
    ./tools/Start-AgentSession.ps1 -Remote Create -Description 'S4 slice groundwork'
    ./tools/Start-AgentSession.ps1 -Remote List
    ./tools/Start-AgentSession.ps1 -Remote Teleport -SessionId abc123

.EXAMPLE
    # Codex only: run the app-server daemon so the Desktop app can attach.
    ./tools/Start-AgentSession.ps1 -Remote Start -Vendor codex
    ./tools/Start-AgentSession.ps1 -Remote Pair  -Vendor codex

.EXAMPLE
    ./tools/Start-AgentSession.ps1 -Status
#>
[CmdletBinding(DefaultParameterSetName = 'Launch')]
param(
    [Parameter(ParameterSetName = 'Launch', Position = 0, Mandatory)]
    [ValidateSet('brief-check', 'design', 'redteam', 'contract', 'slices', 'slice', 'fix',
                 'verify', 'pr', 'resolve', 'track', 'reconcile', 'make-human-docs',
                 'refine', 'install', 'install-all', 'kit-help')]
    [string]$Command,

    [Parameter(ParameterSetName = 'Launch')]
    [string]$Argument,

    [Parameter(ParameterSetName = 'FreeText', Mandatory)]
    [string]$Prompt,

    [Parameter(ParameterSetName = 'FreeText', Mandatory)]
    [ValidateSet('Deep', 'Implementation', 'HighVolume')]
    [string]$Tier,

    [Parameter(ParameterSetName = 'Remote', Mandatory)]
    [ValidateSet('Create', 'List', 'Teleport', 'Start', 'Stop', 'Pair')]
    [string]$Remote,

    [Parameter(ParameterSetName = 'Remote')]
    [string]$Description,

    [Parameter(ParameterSetName = 'Remote')]
    [string]$SessionId,

    [Parameter(ParameterSetName = 'Status', Mandatory)]
    [switch]$Status,

    [ValidateSet('auto', 'claude', 'codex')]
    [string]$Vendor = 'auto',

    [string]$Project = (Get-Location).Path,

    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')]
    [string]$Effort,

    [switch]$Escalate,
    [switch]$Continue,
    [switch]$Desktop,
    [switch]$DryRun,
    [switch]$Force,
    [string]$StatePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:EffortLadder = @('low', 'medium', 'high', 'xhigh', 'max')

function Get-Prop {
    <#
      Set-StrictMode turns a missing property into a terminating error, and
      every JSON document read here is written by someone else's tool. Reading
      through this keeps a shape change from looking like a crash.
    #>
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -isnot [psobject]) { return $null }
    if ($Object.PSObject.Properties.Name -notcontains $Name) { return $null }
    return $Object.$Name
}

function Get-RoutingTable {
    <#
      AGENTS.md § Command routing, transcribed. This is the one place the table
      is duplicated outside that document, and § Single ownership says a
      duplicate must name its canonical copy: AGENTS.md is canonical, and a
      change there is not done until this table changes in the same commit.

      Next     the command AGENTS.md sends you to afterwards, or $null.
      Chain    same-session chain this command belongs to, or $null for fresh.
    #>
    $rows = @(
        @{ Command = 'brief-check';     Tier = 'Deep Reasoning'; Claude = 'opus';   Codex = 'architect'; Effort = 'high';   Next = 'design'  }
        @{ Command = 'design';          Tier = 'Deep Reasoning'; Claude = 'opus';   Codex = 'architect'; Effort = 'high';   Next = 'redteam' }
        @{ Command = 'redteam';         Tier = 'Deep Reasoning'; Claude = 'opus';   Codex = 'architect'; Effort = 'high';   Next = 'contract' }
        @{ Command = 'contract';        Tier = 'Deep Reasoning'; Claude = 'opus';   Codex = 'architect'; Effort = 'high';   Next = 'slices'  }
        @{ Command = 'slices';          Tier = 'Deep Reasoning'; Claude = 'opus';   Codex = 'architect'; Effort = 'high';   Next = 'slice'   }
        @{ Command = 'reconcile';       Tier = 'Deep Reasoning'; Claude = 'opus';   Codex = 'architect'; Effort = 'high';   Next = $null     }
        @{ Command = 'slice';           Tier = 'Implementation'; Claude = 'sonnet'; Codex = 'builder';   Effort = 'medium'; Next = 'verify'; Chain = 'slice' }
        @{ Command = 'fix';             Tier = 'Implementation'; Claude = 'sonnet'; Codex = 'builder';   Effort = 'medium'; Next = 'verify'; Chain = 'fix'   }
        @{ Command = 'verify';          Tier = 'Implementation'; Claude = 'sonnet'; Codex = 'builder';   Effort = 'medium'; Next = 'pr';      Chain = '*'    }
        @{ Command = 'pr';              Tier = 'Implementation'; Claude = 'sonnet'; Codex = 'builder';   Effort = 'medium'; Next = 'resolve'; Chain = '*'    }
        @{ Command = 'resolve';         Tier = 'Implementation'; Claude = 'sonnet'; Codex = 'builder';   Effort = 'medium'; Next = 'track';   Chain = '*'    }
        @{ Command = 'track';           Tier = 'Implementation'; Claude = 'sonnet'; Codex = 'builder';   Effort = 'medium'; Next = $null     }
        @{ Command = 'make-human-docs'; Tier = 'Implementation'; Claude = 'sonnet'; Codex = 'builder';   Effort = 'medium'; Next = $null     }
        @{ Command = 'refine';          Tier = 'Implementation'; Claude = 'sonnet'; Codex = 'builder';   Effort = 'medium'; Next = $null     }
        @{ Command = 'install';         Tier = 'Implementation'; Claude = 'sonnet'; Codex = 'builder';   Effort = 'medium'; Next = $null     }
        @{ Command = 'install-all';     Tier = 'Implementation'; Claude = 'sonnet'; Codex = 'builder';   Effort = 'medium'; Next = $null     }
        @{ Command = 'kit-help';        Tier = 'High Volume';    Claude = 'haiku';  Codex = 'quick';     Effort = 'low';    Next = $null     }
    )

    $table = [ordered]@{}
    foreach ($r in $rows) {
        if (-not $r.ContainsKey('Chain')) { $r['Chain'] = $null }
        $table[$r.Command] = [pscustomobject]$r
    }
    return $table
}

function Get-Chain {
    <#
      The two same-session chains, AGENTS.md § Session boundaries. Membership is
      ordered: a command may only resume a session started earlier in its own
      chain, never one started later.
    #>
    param([string]$Head)
    # switch ($null) executes no branch at all, so the guard is not decoration.
    if (-not $Head) { return @() }
    switch ($Head) {
        'slice' { return @('slice', 'verify', 'pr', 'resolve') }
        'fix'   { return @('fix', 'verify', 'pr', 'resolve') }
        default { return @() }
    }
}

function Get-ProjectSlug {
    param([string]$Path)
    return ($Path -replace '[^A-Za-z0-9]', '-')
}

function Resolve-ProjectRoot {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { throw "No such directory: $Path" }
    $full = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\', '/')

    $top = & git -C $full rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -eq 0 -and $top) {
        return ((Resolve-Path -LiteralPath $top).Path.TrimEnd('\', '/'))
    }

    Write-Warning "$full is not a git repository. State will be keyed on the directory itself."
    return $full
}

function Get-StatePath {
    param([string]$ProjectRoot, [string]$Override)
    if ($Override) { return $Override }
    $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME '.local/state' }
    $dir = Join-Path $base 'SubZeroDev.AgentKit/sessions'
    return (Join-Path $dir ((Get-ProjectSlug $ProjectRoot) + '.json'))
}

function Read-State {
    param([string]$Path)
    $empty = [pscustomobject]@{
        project      = $null
        lastCommand  = $null
        lastVendor   = $null
        lastSessionId = $null
        lastStartedUtc = $null
        chainHead    = $null
        designAuthor = $null
    }
    if (-not (Test-Path -LiteralPath $Path)) { return $empty }
    try {
        $raw = Get-Content -LiteralPath $Path -Raw
        if (-not $raw.Trim()) { return $empty }
        $parsed = $raw | ConvertFrom-Json
    } catch {
        Write-Warning "State file at $Path is unreadable ($($_.Exception.Message)). Treating this as a fresh project."
        return $empty
    }
    foreach ($name in @($empty.PSObject.Properties.Name)) {
        $empty.$name = Get-Prop $parsed $name
    }
    return $empty
}

function Write-State {
    param([string]$Path, $State)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $State | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Path -Encoding utf8NoBOM
}

function Resolve-Vendor {
    <#
      auto is claude everywhere except redteam, where AGENTS.md requires a
      different vendor from the design author. A model recognises its own output
      distribution and defends it, so the default here reads state rather than
      picking a house favourite.
    #>
    param([string]$Requested, [string]$CommandName, $State)

    if ($Requested -ne 'auto') { return $Requested }
    if ($CommandName -ne 'redteam') { return 'claude' }

    $author = Get-Prop $State 'designAuthor'
    if (-not $author) {
        Write-Warning "No recorded design author for this project. Sending redteam to codex; pass -Vendor to override."
        return 'codex'
    }
    return $(if ($author -eq 'claude') { 'codex' } else { 'claude' })
}

function Resolve-Effort {
    param([string]$TableEffort, [string]$Override, [switch]$Bump)

    if ($Override) {
        if ($Override -eq 'max') {
            Write-Warning "max effort selected by name. AGENTS.md reserves it for an explicit request - this is that request."
        }
        return $Override
    }
    if (-not $Bump) { return $TableEffort }

    $i = $script:EffortLadder.IndexOf($TableEffort)
    if ($i -lt 0) { return $TableEffort }
    # Capped at xhigh: the ladder's last rung is never reached by escalation.
    $next = [Math]::Min($i + 1, $script:EffortLadder.IndexOf('xhigh'))
    return $script:EffortLadder[$next]
}

function Get-BoundaryDecision {
    <#
      Returns Mode = Fresh or Same, plus the reason, plus the session id to
      resume when Same. A refusal is expressed as Blocked with a reason, and the
      caller decides whether -Force clears it.
    #>
    param([string]$CommandName, $Row, $State, [bool]$WantContinue)

    $head = Get-Prop $State 'chainHead'
    $last = Get-Prop $State 'lastCommand'
    $sid  = Get-Prop $State 'lastSessionId'
    $lastVendor = Get-Prop $State 'lastVendor'

    # @() around the call, not inside it: an empty array returned from a
    # function unrolls to $null on assignment, and $null.Count is a crash.
    $chain = @(Get-Chain $head)
    $inChain = $chain.Count -gt 0 -and $chain -contains $CommandName -and $chain -contains $last
    $forward = $inChain -and ($chain.IndexOf($CommandName) -gt $chain.IndexOf($last))

    if (-not $WantContinue) {
        if ($forward -and $sid) {
            return [pscustomobject]@{
                Mode = 'Fresh'; SessionId = $null
                Reason = "/$CommandName continues the $head chain, which AGENTS.md keeps in one session. Pass -Continue to resume $($sid.Substring(0,8))."
                Advisory = $true
            }
        }
        return [pscustomobject]@{ Mode = 'Fresh'; SessionId = $null; Reason = 'Fresh session: no same-session chain applies.'; Advisory = $false }
    }

    if (-not $sid) {
        return [pscustomobject]@{ Mode = 'Blocked'; SessionId = $null; Reason = 'No recorded session to continue. Run the chain head first.'; Advisory = $false }
    }
    if (-not $forward) {
        $desc = if ($head) { "the $head chain is at /$last" } else { 'no chain is open' }
        return [pscustomobject]@{
            Mode = 'Blocked'; SessionId = $null
            Reason = "/$CommandName is a fresh-session boundary: $desc. AGENTS.md keeps only slice/fix -> verify -> pr -> resolve in one session."
            Advisory = $false
        }
    }
    if ($chain.IndexOf($CommandName) -gt $chain.IndexOf($last) + 1) {
        $skipped = $chain[($chain.IndexOf($last) + 1)..($chain.IndexOf($CommandName) - 1)]
        Write-Warning "Skipping $($skipped -join ', ') in the $head chain. /pr must carry /verify's did-not-run list verbatim, which it cannot do if /verify never ran."
    }

    return [pscustomobject]@{
        Mode = 'Same'; SessionId = $sid
        Reason = "Same session as /$last ($lastVendor $($sid.Substring(0,8))), per the $head chain."
        Advisory = $false
    }
}

function Resolve-CodexSessionId {
    <#
      Codex has no --session-id to assign at launch, so the id is recovered
      afterwards from the rollout file: line 1 is a session_meta record carrying
      payload.session_id and payload.cwd. Matching on cwd rather than on recency
      alone is what keeps a concurrently-started session in another repository
      from being resumed here.
    #>
    param([string]$ProjectRoot, [datetime]$SinceUtc)

    $root = Join-Path $HOME '.codex/sessions'
    if (-not (Test-Path -LiteralPath $root)) { return $null }

    $files = @(Get-ChildItem -LiteralPath $root -Recurse -Filter 'rollout-*.jsonl' -ErrorAction SilentlyContinue |
               Where-Object { $_.LastWriteTimeUtc -ge $SinceUtc } |
               Sort-Object LastWriteTimeUtc -Descending)

    foreach ($f in $files) {
        $first = Get-Content -LiteralPath $f.FullName -TotalCount 1 -ErrorAction SilentlyContinue
        if (-not $first) { continue }
        try { $meta = $first | ConvertFrom-Json } catch { continue }
        if ((Get-Prop $meta 'type') -ne 'session_meta') { continue }
        $payload = Get-Prop $meta 'payload'
        $cwd = Get-Prop $payload 'cwd'
        if (-not $cwd) { continue }
        if ($cwd.TrimEnd('\', '/') -eq $ProjectRoot) { return (Get-Prop $payload 'session_id') }
    }
    return $null
}

function Get-ClaudeSessionIds {
    param([string]$ProjectRoot, [int]$Count = 5)
    $dir = Join-Path $HOME '.claude/projects' | Join-Path -ChildPath (Get-ProjectSlug $ProjectRoot)
    if (-not (Test-Path -LiteralPath $dir)) { return @() }
    return @(Get-ChildItem -LiteralPath $dir -Filter '*.jsonl' -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending |
             Select-Object -First $Count |
             ForEach-Object { [pscustomobject]@{ Id = $_.BaseName; Modified = $_.LastWriteTime } })
}

function Get-CodexSessionIds {
    param([string]$ProjectRoot, [int]$Count = 5)
    $root = Join-Path $HOME '.codex/sessions'
    if (-not (Test-Path -LiteralPath $root)) { return @() }
    $out = [System.Collections.Generic.List[object]]::new()
    $files = @(Get-ChildItem -LiteralPath $root -Recurse -Filter 'rollout-*.jsonl' -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending)
    foreach ($f in $files) {
        if ($out.Count -ge $Count) { break }
        $first = Get-Content -LiteralPath $f.FullName -TotalCount 1 -ErrorAction SilentlyContinue
        if (-not $first) { continue }
        try { $meta = $first | ConvertFrom-Json } catch { continue }
        if ((Get-Prop $meta 'type') -ne 'session_meta') { continue }
        $payload = Get-Prop $meta 'payload'
        $cwd = Get-Prop $payload 'cwd'
        if (-not $cwd -or $cwd.TrimEnd('\', '/') -ne $ProjectRoot) { continue }
        $out.Add([pscustomobject]@{ Id = (Get-Prop $payload 'session_id'); Modified = $f.LastWriteTime })
    }
    return $out.ToArray()
}

function Write-Banner {
    <#
      AGENTS.md § Model, effort, and review budget: three plain lines, fenced
      above and below by a rule of '=', labels and tier names in Title Case,
      never folded into a paragraph.
    #>
    param([string[]]$Lines)
    $rule = '=' * 31
    Write-Host ''
    Write-Host $rule
    foreach ($l in $Lines) { Write-Host $l }
    Write-Host $rule
    Write-Host ''
}

function Copy-ToClipboard {
    param([string]$Text)
    try { Set-Clipboard -Value $Text; return $true } catch { return $false }
}

function New-LaunchPlan {
    param(
        [string]$VendorName, $Row, [string]$PromptText, [string]$EffortName,
        [string]$ProjectRoot, $Boundary, [bool]$UseDesktop
    )

    $exe = $VendorName
    $argv = [System.Collections.Generic.List[string]]::new()
    $sessionId = $null
    $notes = [System.Collections.Generic.List[string]]::new()

    if ($VendorName -eq 'claude') {
        $model = $Row.Claude
        if ($Boundary.Mode -eq 'Same') {
            $sessionId = $Boundary.SessionId
            $argv.AddRange([string[]]@('--resume', $sessionId))
        } else {
            $sessionId = [guid]::NewGuid().ToString()
            $argv.AddRange([string[]]@('--model', $model, '--session-id', $sessionId))
        }
        $argv.Add($PromptText)
        # Claude Code exposes no effort flag. The tier travels in the banner,
        # which is what AGENTS.md asks the session to read anyway.
        $notes.Add("Claude Code has no CLI effort flag; $EffortName is carried by the banner, not by an argument.")
    } else {
        $model = $Row.Codex
        if ($Boundary.Mode -eq 'Same' -and $Boundary.SessionId) {
            $sessionId = $Boundary.SessionId
            $argv.AddRange([string[]]@('resume', $sessionId))
            $notes.Add('codex resume takes no prompt argument; the prompt is on the clipboard.')
        } else {
            # Bare 'high' is not valid TOML, so codex falls back to the raw
            # string - which is the documented behaviour and keeps double quotes
            # out of a command line that is about to be re-quoted for pwsh.
            $argv.AddRange([string[]]@('--profile', $model, '-c', "model_reasoning_effort=$EffortName"))
            $argv.Add($PromptText)
        }
    }

    if ($UseDesktop) {
        if ($VendorName -eq 'codex') {
            $exe = 'codex'
            $argv = [System.Collections.Generic.List[string]]::new()
            $argv.AddRange([string[]]@('app', $ProjectRoot))
            $notes.Add('codex app opens the workspace only - it takes no profile or prompt. The prompt is on the clipboard, and the profile must be selected in the app.')
        } else {
            $notes.Add('Claude Code 2.1.12 has no verified CLI entry point for the desktop app. Falling back to a terminal session.')
        }
    }

    # Launched through pwsh rather than directly, for two reasons: on Windows
    # both CLIs are npm shims that PowerShell resolves to a .ps1 Start-Process
    # cannot execute, and -NoExit leaves the window standing after the session
    # ends instead of closing over whatever it last printed.
    $inner = @($exe) + @($argv | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" })
    $launchArgs = @('-NoExit', '-NoProfile', '-Command', ('& ' + ($inner -join ' ')))

    return [pscustomobject]@{
        Vendor        = $VendorName
        Model         = $model
        Effort        = $EffortName
        Command       = $exe
        Arguments     = $argv.ToArray()
        Launcher      = 'pwsh'
        LauncherArgs  = $launchArgs
        SessionId     = $sessionId
        SessionMode   = $Boundary.Mode
        Prompt        = $PromptText
        Project       = $ProjectRoot
        Notes         = $notes.ToArray()
        CommandLine   = ($exe + ' ' + (($argv | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '))
    }
}

# ---------------------------------------------------------------------------

$projectRoot = Resolve-ProjectRoot -Path $Project
$statePath = Get-StatePath -ProjectRoot $projectRoot -Override $StatePath
$state = Read-State -Path $statePath

switch ($PSCmdlet.ParameterSetName) {

    'Remote' {
        # Default vendor for remote work is claude, matching the launch path.
        # Start/Stop/Pair have no claude meaning, so those default to codex.
        $v = if ($Vendor -ne 'auto') { $Vendor }
             elseif ($Remote -in @('Start', 'Stop', 'Pair')) { 'codex' }
             else { 'claude' }

        if ($v -eq 'claude' -and $Remote -in @('Start', 'Stop', 'Pair')) {
            throw @"
Claude Code runs no local daemon, so there is nothing to $($Remote.ToLowerInvariant()).
Start/Stop/Pair are Codex app-server verbs; pass -Vendor codex for those.

The claude equivalents of the remote workflow are:
  -Remote Create -Description "..."   claude --remote  (session appears in the
                                      desktop app and at claude.ai/code)
  -Remote List                        claude --teleport, interactive picker
  -Remote Teleport -SessionId <id>    claude --teleport <id>, into this checkout
"@
        }

        if (-not (Get-Command $v -ErrorAction SilentlyContinue)) { throw "$v is not on PATH." }

        $exe = $v
        $argv = @()
        $tierLine = 'Tier: Not Model Work - Session Control'
        $preflight = @()

        switch ($Remote) {
            'Create' {
                if (-not $Description) {
                    throw "-Remote Create needs -Description. It becomes the session title in the desktop app, and this deliberately does not invent one."
                }
                $argv = if ($v -eq 'claude') { @('--remote', $Description) } else { @('cloud', 'exec', $Description) }
                $preflight += "Creates a session on the vendor's servers. That is an external write; running this command is the authorization for it."
            }
            'List' {
                $argv = if ($v -eq 'claude') { @('--teleport') } else { @('cloud', 'list') }
                if ($v -eq 'claude') { $preflight += 'claude --teleport with no id opens an interactive picker rather than printing a list.' }
            }
            'Teleport' {
                if ($v -eq 'codex' -and -not $SessionId) { throw "-Remote Teleport on codex needs -SessionId. Run -Remote List first." }
                $argv = if ($v -eq 'claude') {
                    if ($SessionId) { @('--teleport', $SessionId) } else { @('--teleport') }
                } else { @('cloud', 'apply', $SessionId) }

                # claude --teleport refuses on a dirty tree and from the wrong
                # repository. Checking here turns a Sessions API round trip into
                # a git status.
                $porcelain = & git -C $projectRoot status --porcelain 2>$null
                if ($LASTEXITCODE -ne 0) {
                    throw "$projectRoot is not a git repository. Teleport requires a checkout of the session's repository."
                }
                if ($porcelain) {
                    throw @"
Working tree is not clean. Teleport refuses to run over uncommitted work, and
this stops before the API call rather than after it.

$($porcelain -join "`n")

Commit or stash, then re-run.
"@
                }
                $preflight += 'Teleport must run from a checkout of the session''s own repository; the CLI rejects a mismatch after the fetch.'
            }
            default {
                $exe = 'codex'
                $argv = @('remote-control', $Remote.ToLowerInvariant())
                $tierLine = 'Tier: Not Model Work - Daemon Control'
                $preflight += 'remote-control is marked experimental by codex 0.146.0, and pair codes are short-lived.'
            }
        }

        Write-Banner @(
            "Work: -Remote $Remote on $v",
            $tierLine,
            "Session: $(if ($Remote -eq 'Create') { 'New Remote' } elseif ($Remote -eq 'Teleport') { 'Resumed Locally' } else { 'None' })"
        )
        foreach ($n in $preflight) { Write-Host "note: $n" -ForegroundColor DarkGray }

        $display = $exe + ' ' + (($argv | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
        Write-Host $display -ForegroundColor DarkGray

        if ($DryRun) {
            [pscustomobject]@{ Vendor = $v; Command = $exe; Arguments = $argv; CommandLine = $display }
            break
        }

        # Run in this console rather than a new window: Create prints the id and
        # resume line to stdout, and List's picker needs the current terminal.
        & $exe @argv
        break
    }

    'Status' {
        $routing = Get-RoutingTable
        Write-Banner @(
            "Work: Session Status",
            "Tier: Not Model Work - Report",
            "Session: $projectRoot"
        )

        $last = Get-Prop $state 'lastCommand'
        if (-not $last) {
            Write-Host 'No recorded session for this project.'
        } else {
            $sid = Get-Prop $state 'lastSessionId'
            Write-Host ("Last:          /{0} on {1}{2}" -f $last, (Get-Prop $state 'lastVendor'),
                        $(if ($sid) { " ($($sid.Substring(0,8)))" } else { '' }))
            Write-Host ("Started (UTC): {0}" -f (Get-Prop $state 'lastStartedUtc'))
            Write-Host ("Chain head:    {0}" -f $(if (Get-Prop $state 'chainHead') { '/' + (Get-Prop $state 'chainHead') } else { 'none - next command is fresh' }))
            Write-Host ("Design author: {0}" -f $(if (Get-Prop $state 'designAuthor') { Get-Prop $state 'designAuthor' } else { 'unrecorded - redteam will default to codex' }))

            if ($routing.Contains($last)) {
                $next = $routing[$last].Next
                if ($next) {
                    $chain = @(Get-Chain (Get-Prop $state 'chainHead'))
                    $same = $chain -contains $next -and $chain -contains $last -and ($chain.IndexOf($next) -gt $chain.IndexOf($last))
                    $how = if ($same) { 'same session - pass -Continue' } else { 'FRESH session' }
                    Write-Host ""
                    Write-Host ("Next:          /{0} ({1}, {2}/{3})" -f $next, $how, $routing[$next].Claude, $routing[$next].Effort)
                }
            }
        }

        Write-Host ''
        Write-Host 'Claude sessions on disk (newest first):'
        $cs = @(Get-ClaudeSessionIds -ProjectRoot $projectRoot)
        if ($cs.Count -eq 0) { Write-Host '  none' } else { $cs | ForEach-Object { Write-Host ("  {0}  {1}" -f $_.Id, $_.Modified) } }

        Write-Host ''
        Write-Host 'Codex sessions on disk (newest first):'
        $xs = @(Get-CodexSessionIds -ProjectRoot $projectRoot)
        if ($xs.Count -eq 0) { Write-Host '  none' } else { $xs | ForEach-Object { Write-Host ("  {0}  {1}" -f $_.Id, $_.Modified) } }

        Write-Host ''
        Write-Host ("State file: {0}" -f $statePath) -ForegroundColor DarkGray
        break
    }

    default {
        $routing = Get-RoutingTable

        if ($PSCmdlet.ParameterSetName -eq 'FreeText') {
            $tierMap = @{
                Deep           = @{ Tier = 'Deep Reasoning'; Claude = 'opus';   Codex = 'architect'; Effort = 'high'   }
                Implementation = @{ Tier = 'Implementation'; Claude = 'sonnet'; Codex = 'builder';   Effort = 'medium' }
                HighVolume     = @{ Tier = 'High Volume';    Claude = 'haiku';  Codex = 'quick';     Effort = 'low'    }
            }
            $row = [pscustomobject]($tierMap[$Tier] + @{ Command = '(free text)'; Next = $null; Chain = $null })
            $commandName = '(free text)'
            $promptText = $Prompt
        } else {
            $row = $routing[$Command]
            $commandName = $Command
            $promptText = if ($Argument) { "/$Command $Argument" } else { "/$Command" }
        }

        $vendorName = Resolve-Vendor -Requested $Vendor -CommandName $commandName -State $state
        if (-not (Get-Command $vendorName -ErrorAction SilentlyContinue)) {
            throw "$vendorName is not on PATH."
        }

        $effortName = Resolve-Effort -TableEffort $row.Effort -Override $Effort -Bump:$Escalate

        # AGENTS.md permits redteam on the design author's vendor as a degraded
        # fallback ("If it must be Claude, a fresh opus, high session"), so this
        # warns rather than blocks. The blocking case is carrying a session
        # across a fresh boundary, below.
        if ($commandName -eq 'redteam') {
            $author = Get-Prop $state 'designAuthor'
            if ($author -and $author -eq $vendorName) {
                Write-Warning "redteam is running on $vendorName, which also wrote the design. AGENTS.md wants a different vendor; this is the degraded fallback, and it must at minimum be a fresh session."
            }
        }

        $boundary = Get-BoundaryDecision -CommandName $commandName -Row $row -State $state -WantContinue:$Continue.IsPresent

        if ($boundary.Mode -eq 'Blocked') {
            if (-not $Force) {
                Write-Banner @(
                    "Session Boundary - Refused",
                    "Work: /$commandName",
                    "Reason: $($boundary.Reason)"
                )
                # The reason travels in the exception, not only in the banner:
                # a caller that redirected host output still has to be able to
                # tell which boundary refused.
                throw "Refusing to continue across a session boundary. $($boundary.Reason) Re-run without -Continue for a fresh session, or with -Force to override."
            }
            Write-Warning "-Force overrides a session boundary: $($boundary.Reason)"
            $sid = Get-Prop $state 'lastSessionId'
            $boundary = [pscustomobject]@{ Mode = 'Same'; SessionId = $sid; Reason = 'Forced continuation across a boundary.'; Advisory = $false }
        }

        if ($boundary.Mode -eq 'Same' -and $vendorName -ne (Get-Prop $state 'lastVendor')) {
            throw "Cannot continue a $(Get-Prop $state 'lastVendor') session on $vendorName. Sessions do not cross vendors; drop -Continue to start fresh."
        }

        $plan = New-LaunchPlan -VendorName $vendorName -Row $row -PromptText $promptText `
                               -EffortName $effortName -ProjectRoot $projectRoot `
                               -Boundary $boundary -UseDesktop:$Desktop.IsPresent

        $modelLabel = if ($vendorName -eq 'claude') { $plan.Model } else { "$($plan.Model) profile" }
        $sessionLine = if ($boundary.Mode -eq 'Same') {
            "Session: Same - $vendorName, $modelLabel, $($plan.SessionId.Substring(0,8))"
        } else {
            "Session: Fresh - $vendorName, $modelLabel"
        }
        Write-Banner @(
            "Work: $promptText",
            "Tier: $($row.Tier) - $modelLabel/$effortName",
            $sessionLine
        )

        if ($boundary.Advisory) { Write-Host $boundary.Reason -ForegroundColor Yellow }
        foreach ($n in $plan.Notes) { Write-Host "note: $n" -ForegroundColor DarkGray }
        Write-Host $plan.CommandLine -ForegroundColor DarkGray

        if ($DryRun) { $plan; break }

        $needsClipboard = $Desktop -or ($vendorName -eq 'codex' -and $boundary.Mode -eq 'Same')
        if ($needsClipboard) {
            if (Copy-ToClipboard $promptText) { Write-Host "Prompt copied to clipboard." -ForegroundColor DarkGray }
            else { Write-Warning "Could not reach the clipboard. Prompt: $promptText" }
        }

        Start-Process -FilePath $plan.Launcher -ArgumentList $plan.LauncherArgs -WorkingDirectory $projectRoot

        # Codex assigns its own id, so it is read back from the rollout file the
        # session is about to write. A null here is not fatal - it only costs the
        # next -Continue its resume target, and -Status still lists the ids.
        $startedUtc = (Get-Date).ToUniversalTime()
        $recordedId = $plan.SessionId
        if ($vendorName -eq 'codex' -and $boundary.Mode -ne 'Same') {
            $deadline = $startedUtc.AddSeconds(20)
            while ((Get-Date).ToUniversalTime() -lt $deadline -and -not $recordedId) {
                Start-Sleep -Milliseconds 750
                $recordedId = Resolve-CodexSessionId -ProjectRoot $projectRoot -SinceUtc $startedUtc.AddMinutes(-1)
            }
            if (-not $recordedId) {
                Write-Warning "Could not read back a codex session id within 20s. -Continue will have nothing to resume; use -Status to find the id."
            }
        }

        $chainHead = if ($row.Chain -eq '*') { Get-Prop $state 'chainHead' } else { $row.Chain }
        $state.project        = $projectRoot
        $state.lastCommand    = $commandName
        $state.lastVendor     = $vendorName
        $state.lastSessionId  = $recordedId
        $state.lastStartedUtc = $startedUtc.ToString('o')
        $state.chainHead      = $chainHead
        if ($commandName -in @('brief-check', 'design', 'contract', 'slices')) {
            $state.designAuthor = $vendorName
        }
        Write-State -Path $statePath -State $state

        if ($row.Next) {
            $nextRow = $routing[$row.Next]
            $chain = @(Get-Chain $chainHead)
            $same = $chain -contains $row.Next -and $chain -contains $commandName -and ($chain.IndexOf($row.Next) -gt $chain.IndexOf($commandName))
            if ($same) {
                Write-Host ("Next: /{0} in this same session - re-run with -Command {0} -Continue" -f $row.Next) -ForegroundColor DarkGray
            } else {
                $nextVendor = if ($row.Next -eq 'redteam') { $(if ($vendorName -eq 'claude') { 'codex' } else { 'claude' }) } else { $vendorName }
                Write-Banner @(
                    "Session Boundary - Do Not Carry Into /$($row.Next)",
                    "Next: /$($row.Next), Fresh Session, $($nextRow.Claude)/$($nextRow.Effort)",
                    "Vendor: $nextVendor"
                )
            }
        }
        break
    }
}
