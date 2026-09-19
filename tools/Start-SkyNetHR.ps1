#Requires -Version 7.0

<#
.SYNOPSIS
    Bring the local development stack up and report when the console is reachable.

.DESCRIPTION
    docker-compose.dev.yml already describes the whole local stack; what it cannot do is
    supply the four values it refuses to start without. Three of them are host paths only
    this machine knows (the workspace tree the jail is allowed to open sessions against,
    and each vendor CLI's already-authenticated credential directory), and the fourth is a
    shared secret that has to be the same value on two sides - the container's AUTH_SECRET
    and whatever gets typed into the console's login box. Exporting all four by hand on
    every run is the only reason this repository is harder to start than it is to build.

    So this script resolves them once and persists them to a git-ignored `.env` beside the
    compose file, which Compose then loads on its own for `${...}` interpolation - the same
    mechanism the deployment file's header points a manual operator at. A second run reads
    that file back rather than minting a new secret, so the login value stays stable across
    restarts; pass -AuthSecret, or edit `.env`, to change it deliberately.

    ALLOWED_ORIGINS is derived from -Port rather than left at the compose default: the
    origin check on every mutating route compares against it literally, so a non-default
    port with the default origin authenticates and then rejects every write.

    Readiness is `GET /readyz` (src/edge/http-common/index.ts), which is unauthenticated
    and reads only the flag src/server.ts flips once the listener is bound - polling the
    console's own HTML instead would report ready while the store was still opening. A
    container that exits during startup is detected and its log dumped, rather than waited
    on until the timeout.

    Nothing here writes a vendor credential. The container holds none of its own
    (design/00-brief.md's "Hosting the model" non-goal); an empty credential directory is
    created where one is missing, which is the documented way to leave a vendor
    unauthenticated - its sessions then fail per-turn auth rather than container startup.

.PARAMETER WorkspaceRoot
    Host directory bind-mounted at /workspaces - the tree sessions may be opened against.
    Defaults to this repository, which is a jail small enough to be obviously safe for a
    first run; point it at a wider project tree once you trust it.

.PARAMETER ClaudeCredentialsDir
    Host directory bind-mounted over /home/node/.claude. Defaults to ~/.claude.

.PARAMETER CodexCredentialsDir
    Host directory bind-mounted over /home/node/.codex. Defaults to ~/.codex.

.PARAMETER Port
    Host port to publish. The container always serves on 3000.

.PARAMETER AuthSecret
    Shared secret for AUTH_MODE=shared-secret. Omitted, an existing value in `.env` is
    reused and a missing one is generated.

.PARAMETER NoBuild
    Start the existing image without rebuilding it.

.PARAMETER Recreate
    Force-recreate the container even when its configuration has not changed.

.PARAMETER Stop
    Stop the container, leaving it and the storage volume in place. Nothing is started.

.PARAMETER Down
    Stop and remove the container. The named storage volume is kept - transcripts,
    checkpoints and the audit log survive.

.PARAMETER Logs
    Follow the container's log instead of starting anything.

.PARAMETER ReadyTimeoutSeconds
    How long to poll /readyz after the container starts.

.EXAMPLE
    ./tools/Start-SkyNetHR.ps1
.EXAMPLE
    ./tools/Start-SkyNetHR.ps1 -WorkspaceRoot D:\Dropbox\Projects -Port 8080
.EXAMPLE
    ./tools/Start-SkyNetHR.ps1 -Logs
.EXAMPLE
    ./tools/Start-SkyNetHR.ps1 -Down
#>

[CmdletBinding()]
param(
    [string]$WorkspaceRoot,
    [string]$ClaudeCredentialsDir,
    [string]$CodexCredentialsDir,
    [int]$Port = 3000,
    [string]$AuthSecret,
    [switch]$NoBuild,
    [switch]$Recreate,
    [switch]$Stop,
    [switch]$Down,
    [switch]$Logs,
    [int]$ReadyTimeoutSeconds = 120
)

Set-StrictMode -Version Latest

<#
  Compose's dotenv reader is not a shell: an unquoted value is taken literally to end of
  line, but a double-quoted one has escape sequences processed, so a Windows path written
  with backslashes is one `\t` or `\n` away from silently becoming a different path.
  Normalising to forward slashes sidesteps the question entirely - Docker Desktop accepts
  `C:/src/foo` and `C:\src\foo` alike - and keeps the file readable when a path is edited
  by hand later.
#>
function ConvertTo-ComposePath {
    param([Parameter(Mandatory)][string]$Path)

    $expanded = [System.Environment]::ExpandEnvironmentVariables($Path)
    $full = [System.IO.Path]::GetFullPath($expanded)
    return ($full -replace '\\', '/').TrimEnd('/')
}

<#
  Hex, not base64. The value travels through a JSON body, a Set-Cookie header and whatever
  the operator pastes into the login box; base64's `+`, `/` and `=` each have a meaning in
  at least one of those, and the identity resolver compares the decoded cookie
  byte-for-byte. 32 bytes is the secret's whole strength - the length of its encoding is
  not.
#>
function New-SkyNetHRSecret {
    param([int]$ByteCount = 32)

    $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes($ByteCount)
    return [System.Convert]::ToHexString($bytes).ToLowerInvariant()
}

<#
  Reads only what this script writes: `KEY=value`, one per line, no quoting, no `export`
  prefix, `#` comments. It is deliberately not a general dotenv parser - a value this
  script did not write is preserved verbatim rather than reinterpreted, which is what makes
  hand-editing `.env` safe.
#>
function Read-EnvFile {
    param([Parameter(Mandatory)][string]$Path)

    $map = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $map }

    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $eq = $trimmed.IndexOf('=')
        if ($eq -lt 1) { continue }
        $map[$trimmed.Substring(0, $eq).Trim()] = $trimmed.Substring($eq + 1)
    }
    return $map
}

# UTF-8 without BOM and LF endings, per AGENTS.md's house conventions - and because
# Compose's reader treats a BOM as part of the first key's name.
function Write-EnvFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Values,
        [string[]]$Header = @()
    )

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($comment in $Header) { $lines.Add("# $comment") }
    if ($Header.Count -gt 0) { $lines.Add('') }
    foreach ($key in $Values.Keys) { $lines.Add("$key=$($Values[$key])") }

    $text = ($lines -join "`n") + "`n"
    [System.IO.File]::WriteAllText($Path, $text, [System.Text.UTF8Encoding]::new($false))
}

<#
  An explicit argument wins, then whatever `.env` already holds, then the default. The
  ordering is what makes a second run reuse the first run's secret instead of minting a new
  one and locking the operator out of a console they were already logged into.
#>
function Resolve-EnvValue {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Existing,
        [Parameter(Mandatory)][string]$Key,
        [string]$Explicit,
        [Parameter(Mandatory)][scriptblock]$Default
    )

    if (-not [string]::IsNullOrWhiteSpace($Explicit)) { return $Explicit }
    if ($Existing.Contains($Key) -and -not [string]::IsNullOrWhiteSpace($Existing[$Key])) {
        return $Existing[$Key]
    }
    return (& $Default)
}

<#
  README.md records this failure mode: the container's `codex` is a pinned Linux build, and
  a `.codex` written by a different build can carry a session-state SQLite file at a schema
  migration it refuses to open - failing the turn with "Operation not permitted" before any
  network call. Detected and reported rather than moved aside: deleting an operator's
  session state is not this script's call to make.
#>
function Get-CodexStateHazard {
    param([Parameter(Mandatory)][string]$Path)

    # The leading comma is load-bearing: PowerShell unrolls a returned array, so without it
    # the no-hazard case returns $null and the one-hazard case returns a bare string - and
    # `.Count` on either is a terminating error under Set-StrictMode, in the caller rather
    # than here.
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return , @() }
    return , @(Get-ChildItem -LiteralPath $Path -Filter 'state_*.sqlite' -File -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName })
}

function Invoke-Compose {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $composeFile = Join-Path $RepoRoot 'docker-compose.dev.yml'
    # `Out-Host`, not a bare call: compose's own progress output would otherwise join this
    # function's pipeline, and the caller's `$code` would be the whole build log with the
    # exit code appended - which compares unequal to 0 and fails a build that succeeded.
    & docker compose --project-directory $RepoRoot -f $composeFile @Arguments | Out-Host
    return $LASTEXITCODE
}

# `docker compose ps` answers from the daemon, so a container that died during startup is
# visible here well before the readiness poll would time out on it.
function Get-ComposeServiceState {
    param([Parameter(Mandatory)][string]$RepoRoot)

    $composeFile = Join-Path $RepoRoot 'docker-compose.dev.yml'
    $json = & docker compose --project-directory $RepoRoot -f $composeFile ps --format json 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($json -join ''))) { return $null }

    # Compose v2 emits one JSON object per line, not an array.
    foreach ($line in @($json)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $parsed = $line | ConvertFrom-Json } catch { continue }
        foreach ($entry in @($parsed)) {
            # Property access, not `.Service` directly: Set-StrictMode turns a field Compose
            # renames or omits into a terminating error rather than a no-match.
            $service = $entry.PSObject.Properties['Service']
            if ($null -ne $service -and $service.Value -eq 'skynet-hr') { return $entry }
        }
    }
    return $null
}

function Wait-SkyNetHRReady {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $url = "http://localhost:$Port/readyz"

    while ((Get-Date) -lt $deadline) {
        $state = Get-ComposeServiceState -RepoRoot $RepoRoot
        $stateName = if ($null -eq $state) { $null } else { $state.PSObject.Properties['State'] }
        if ($null -ne $stateName -and $stateName.Value -notin @('running', 'restarting', 'created')) {
            return [pscustomobject]@{ Ready = $false; Reason = "container state is '$($stateName.Value)'" }
        }

        try {
            $response = Invoke-WebRequest -Uri $url -TimeoutSec 5 -SkipHttpErrorCheck -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                return [pscustomobject]@{ Ready = $true; Reason = $null }
            }
        } catch {
            # Connection refused while the listener is still binding. Keep polling.
        }
        Start-Sleep -Milliseconds 700
    }

    return [pscustomobject]@{ Ready = $false; Reason = "no 200 from $url within $TimeoutSeconds s" }
}

function Invoke-StartSkyNetHR {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [string]$WorkspaceRoot,
        [string]$ClaudeCredentialsDir,
        [string]$CodexCredentialsDir,
        [int]$Port = 3000,
        [string]$AuthSecret,
        [switch]$NoBuild,
        [switch]$Recreate,
        [switch]$Stop,
        [switch]$Down,
        [switch]$Logs,
        [int]$ReadyTimeoutSeconds = 120
    )

    $composeFile = Join-Path $RepoRoot 'docker-compose.dev.yml'
    if (-not (Test-Path -LiteralPath $composeFile -PathType Leaf)) {
        throw "docker-compose.dev.yml not found at '$composeFile'."
    }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'docker was not found on PATH. Install Docker Desktop, or start it if it is installed.'
    }

    # `docker info` rather than `docker version`: the latter answers from the client alone,
    # so it succeeds while the daemon is still starting and every later call fails instead.
    & docker info --format '{{.ServerVersion}}' 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'The Docker daemon is not reachable. Start Docker Desktop and wait for it to report running.'
    }

    if ($Logs) {
        Invoke-Compose -RepoRoot $RepoRoot -Arguments @('logs', '-f', 'skynet-hr') | Out-Null
        return
    }
    if ($Down) {
        $code = Invoke-Compose -RepoRoot $RepoRoot -Arguments @('down')
        if ($code -ne 0) { throw "docker compose down exited $code" }
        Write-Host 'Container removed. The skynet-hr-dev-storage volume was kept.' -ForegroundColor Green
        return
    }
    if ($Stop) {
        $code = Invoke-Compose -RepoRoot $RepoRoot -Arguments @('stop')
        if ($code -ne 0) { throw "docker compose stop exited $code" }
        Write-Host 'Container stopped.' -ForegroundColor Green
        return
    }

    $envPath = Join-Path $RepoRoot '.env'
    $existing = Read-EnvFile -Path $envPath

    $resolvedWorkspace = ConvertTo-ComposePath (Resolve-EnvValue -Existing $existing -Key 'WORKSPACE_ROOTS_HOST_DIR' -Explicit $WorkspaceRoot -Default { $RepoRoot })
    $resolvedClaude = ConvertTo-ComposePath (Resolve-EnvValue -Existing $existing -Key 'CLAUDE_CREDENTIALS_DIR' -Explicit $ClaudeCredentialsDir -Default { Join-Path $HOME '.claude' })
    $resolvedCodex = ConvertTo-ComposePath (Resolve-EnvValue -Existing $existing -Key 'CODEX_CREDENTIALS_DIR' -Explicit $CodexCredentialsDir -Default { Join-Path $HOME '.codex' })
    $resolvedSecret = Resolve-EnvValue -Existing $existing -Key 'AUTH_SECRET' -Explicit $AuthSecret -Default { New-SkyNetHRSecret }

    if (-not (Test-Path -LiteralPath $resolvedWorkspace -PathType Container)) {
        throw "WorkspaceRoot '$resolvedWorkspace' does not exist. Point -WorkspaceRoot at a directory that does."
    }

    # An absent credential directory is created empty rather than refused: the compose
    # file's header calls an empty mount the documented way to leave a vendor
    # unauthenticated, and the daemon would otherwise create the missing bind source itself
    # with ownership this script cannot see.
    foreach ($dir in @($resolvedClaude, $resolvedCodex)) {
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            Write-Host "Created empty credential directory '$dir' - that vendor's sessions will fail per-turn auth until its CLI is authenticated on this host." -ForegroundColor Yellow
        }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $resolvedClaude '.credentials.json') -PathType Leaf)) {
        Write-Host "No .credentials.json under '$resolvedClaude'. Run 'claude' on this host and sign in before opening a Claude session." -ForegroundColor Yellow
    }
    $hazards = Get-CodexStateHazard -Path $resolvedCodex
    if ($hazards.Count -gt 0) {
        Write-Host "Codex session-state files found that the container's pinned codex build may refuse to open (README.md, 'Running it on Windows'):" -ForegroundColor Yellow
        foreach ($hazard in $hazards) { Write-Host "  $hazard" -ForegroundColor Yellow }
        Write-Host '  Move them aside if a codex turn fails with "Operation not permitted". auth.json and config.toml are unaffected.' -ForegroundColor Yellow
    }

    $values = [ordered]@{
        WORKSPACE_ROOTS_HOST_DIR = $resolvedWorkspace
        CLAUDE_CREDENTIALS_DIR   = $resolvedClaude
        CODEX_CREDENTIALS_DIR    = $resolvedCodex
        AUTH_MODE                = 'shared-secret'
        AUTH_COOKIE_NAME         = 'skynet_hr_session'
        AUTH_SECRET              = $resolvedSecret
        SKYNET_HR_PORT           = "$Port"
        # The origin check on every mutating route compares this literally, so it has to
        # track -Port rather than stay at the compose file's localhost:3000 default.
        ALLOWED_ORIGINS          = "http://localhost:$Port"
    }
    foreach ($key in $existing.Keys) {
        if (-not $values.Contains($key)) { $values[$key] = $existing[$key] }
    }

    Write-EnvFile -Path $envPath -Values $values -Header @(
        'Written by tools/Start-SkyNetHR.ps1 for docker-compose.dev.yml. Git-ignored.'
        'Edit freely - a re-run reuses what is here rather than overwriting it.'
        'AUTH_SECRET is this deployment''s login. Deleting the line mints a new one.'
    )

    $arguments = @('up', '-d')
    if (-not $NoBuild) { $arguments += '--build' }
    if ($Recreate) { $arguments += '--force-recreate' }

    Write-Host "Starting skynet-hr on port $Port (workspace jail: $resolvedWorkspace)..." -ForegroundColor Cyan
    $code = Invoke-Compose -RepoRoot $RepoRoot -Arguments $arguments
    if ($code -ne 0) { throw "docker compose up exited $code" }

    $ready = Wait-SkyNetHRReady -RepoRoot $RepoRoot -Port $Port -TimeoutSeconds $ReadyTimeoutSeconds
    if (-not $ready.Ready) {
        Write-Host "Never became ready: $($ready.Reason). Last 60 log lines:" -ForegroundColor Red
        Invoke-Compose -RepoRoot $RepoRoot -Arguments @('logs', '--tail', '60', 'skynet-hr') | Out-Null
        throw "skynet-hr did not become ready: $($ready.Reason)"
    }

    Write-Host ''
    Write-Host "  Console   http://localhost:$Port" -ForegroundColor Green
    Write-Host "  Secret    $resolvedSecret" -ForegroundColor Green
    Write-Host ''
    Write-Host "  Paste the secret into the console's login box; it mints the HttpOnly" -ForegroundColor DarkGray
    Write-Host "  skynet_hr_session cookie for you. It is stored in .env and reused on the" -ForegroundColor DarkGray
    Write-Host "  next run, so this value stays stable across restarts." -ForegroundColor DarkGray
    Write-Host ''
    Write-Host "  Logs      ./tools/Start-SkyNetHR.ps1 -Logs" -ForegroundColor DarkGray
    Write-Host "  Stop      ./tools/Start-SkyNetHR.ps1 -Stop" -ForegroundColor DarkGray
}

# Guards the invoking wrapper so this script's tests can dot-source it instead - see
# Test-WriteSurface.ps1/Wait-PullRequestCheck.ps1 for the same structure and why.
if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    # `docker` exits non-zero on the paths this script handles itself (daemon down, compose
    # up failing). In 7.3+ that becomes a terminating error under 'Stop' before $LASTEXITCODE
    # is ever read, turning every handled case into a raw stack trace - same reason
    # Test-WriteSurface.ps1 clears it.
    $PSNativeCommandUseErrorActionPreference = $false
    $repoRoot = Split-Path -Parent $PSScriptRoot

    Invoke-StartSkyNetHR `
        -RepoRoot $repoRoot `
        -WorkspaceRoot $WorkspaceRoot `
        -ClaudeCredentialsDir $ClaudeCredentialsDir `
        -CodexCredentialsDir $CodexCredentialsDir `
        -Port $Port `
        -AuthSecret $AuthSecret `
        -NoBuild:$NoBuild `
        -Recreate:$Recreate `
        -Stop:$Stop `
        -Down:$Down `
        -Logs:$Logs `
        -ReadyTimeoutSeconds $ReadyTimeoutSeconds
}
