#Requires -Version 7.0
<#
.SYNOPSIS
    Registers the built server as a Windows Service via NSSM, refusing to install with a
    credential or a required setting left to default.

.DESCRIPTION
    The container story (Dockerfile, docker-compose.yml) is Linux-only by construction: it
    validates the Linux process model (tini as pid 1, SIGTERM forwarding) that Docker
    Desktop's WSL2 layer would mask on a native Windows host, and the brief's own Constraints
    name path handling, process termination and workspace rollback as the three things that
    differ between the two platforms (design/00-brief.md). Running the same Linux container
    under Docker Desktop would exercise Linux's termination path a second time, not Windows'.
    This script is the Windows-native answer instead: no container, no bind mounts - the
    compiled server runs directly on the host as a Windows Service, managed by NSSM
    (https://nssm.cc, an operator-installed tool, the Windows analogue to Docker itself - not
    a project dependency).

    Credential parity with the Linux artifact comes for free rather than needing a bind
    mount: -ServiceAccount should name the operator's own Windows account (or a service
    account with `.claude`/`.codex` already set up under its profile), so `claude`/`codex`
    resolve `%USERPROFILE%\.claude` and `%USERPROFILE%\.codex` exactly as they would run
    interactively (design/00-brief.md's "Hosting the model" non-goal: no vendor credential is
    held by anything this script writes).

    Graceful shutdown reaches the same code path as the container's SIGTERM handling
    (src/server.ts's `stop()`), but through a different signal: Node does not reliably
    receive SIGTERM from the Windows service manager (a delivered SIGTERM there bypasses any
    handler and hard-kills), but it does receive SIGINT from a console Ctrl+C event, which
    `server.ts` already listens for (`process.on('SIGINT', ...)`, added for the same local
    Ctrl+C case). NSSM's default stop sequence tries exactly that first - a console control
    event - before escalating, so no extra configuration is needed for the signal to arrive;
    -StopTimeoutMs only sets how long NSSM waits for `stop()`'s drain-then-kill sequence to
    finish before it escalates to a harder stop.

    Required settings are validated against the same fields src/config/index.ts's
    `loadConfig` refuses to start without (AUTH_MODE and its per-mode fields, WORKSPACE_ROOTS,
    STORAGE_ROOT), plus ALLOWED_ORIGINS, which docker-compose.yml also requires with no
    default even though the app itself falls back to an empty list - the deployment-level
    policy this script mirrors, not a gap in the app. Nothing here supplies a default for any
    of them; a missing one fails this script before NSSM is touched, the same "fail closed on
    startup" property the compose file gets from `${VAR:?...}` interpolation.

.PARAMETER EnvFile
    Path to a file of KEY=VALUE lines (blank lines and lines starting with `#` ignored) the
    service environment is read from. Not committed anywhere - this is this host's own
    deployment configuration, the Windows-native equivalent of the compose files' `${...}`
    interpolation.

.PARAMETER ServiceName
    Windows service name. Default `SkyNetHR`.

.PARAMETER ServiceAccount
    Windows account NSSM runs the service as, `DOMAIN\User` or `.\User` form. Defaults to
    LocalSystem when omitted, which has no `.claude`/`.codex` profile of its own - name the
    operator's own account (or a dedicated service account whose profile already holds both
    CLIs' credential state) unless you intend to configure HOME explicitly in EnvFile instead.

.PARAMETER RepoRoot
    Repository root containing the built `dist/server.js`. Defaults to the current directory.
    Run `npm run build` first; this script does not build.

.PARAMETER NssmPath
    Path to nssm.exe. Defaults to resolving `nssm` on PATH.

.PARAMETER StopTimeoutMs
    Milliseconds NSSM waits after the console stop event before escalating to a harder stop.
    Default 30000 - generous enough for `server.ts`'s drain step to close idle connections
    before the force-close bound it applies to whatever is still open.

.EXAMPLE
    ./tools/Install-WindowsService.ps1 -EnvFile C:\skynet-hr\deploy.env -ServiceAccount .\skynet-operator
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $EnvFile,
    [string] $ServiceName    = 'SkyNetHR',
    [string] $ServiceAccount,
    [string] $RepoRoot       = (Get-Location).Path,
    [string] $NssmPath       = 'nssm',
    [int]    $StopTimeoutMs  = 30000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Mirrors src/config/index.ts's parseAuth: which fields AUTH_MODE makes mandatory.
$script:AuthModeFields = @{
    'proxy-header' = @('AUTH_USER_HEADER')
    'open-webui'   = @('AUTH_USER_HEADER', 'AUTH_SESSION_HEADER')
    'shared-secret' = @('AUTH_COOKIE_NAME', 'AUTH_SECRET')
}
$script:AlwaysRequired = @('AUTH_MODE', 'ALLOWED_ORIGINS', 'WORKSPACE_ROOTS', 'STORAGE_ROOT')

function Read-EnvFile {
    <# Hashtable of KEY=VALUE from a simple env file, or throws if the file is missing.
       No quoting/escaping support - deliberately as small as the deployment format needs. #>
    param([Parameter(Mandatory)] [string] $Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "EnvFile not found: $Path"
    }
    $vars = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $idx = $trimmed.IndexOf('=')
        if ($idx -lt 1) { throw "EnvFile line is not KEY=VALUE: '$line'" }
        $key = $trimmed.Substring(0, $idx).Trim()
        $value = $trimmed.Substring($idx + 1)
        $vars[$key] = $value
    }
    return $vars
}

function Test-RequiredEnv {
    <# .Ok = $true, or .Ok = $false and .MissingFields names every field absent or empty -
       collected in full rather than failing on the first one, so a misconfigured EnvFile is
       fixed in one pass instead of one refusal at a time. #>
    param([Parameter(Mandatory)] [hashtable] $Vars)

    $missing = [System.Collections.Generic.List[string]]::new()
    $required = [System.Collections.Generic.List[string]]::new()
    foreach ($field in $script:AlwaysRequired) { $required.Add($field) }

    $mode = $Vars['AUTH_MODE']
    if ([string]::IsNullOrEmpty($mode)) {
        # AUTH_MODE itself is already in AlwaysRequired; no per-mode fields to add when it's
        # missing - there is no mode to look them up by.
    }
    elseif ($script:AuthModeFields.ContainsKey($mode)) {
        foreach ($field in $script:AuthModeFields[$mode]) { $required.Add($field) }
    }
    else {
        $missing.Add("AUTH_MODE (unknown value '$mode' - expected proxy-header, open-webui or shared-secret)")
    }

    foreach ($field in $required) {
        if ([string]::IsNullOrEmpty($Vars[$field])) { $missing.Add($field) }
    }

    if ($missing.Count -gt 0) {
        return [pscustomobject]@{ Ok = $false; MissingFields = @($missing | Select-Object -Unique) }
    }
    return [pscustomobject]@{ Ok = $true; MissingFields = @() }
}

function Invoke-Install {
    param(
        [Parameter(Mandatory)] [string] $EnvFile,
        [Parameter(Mandatory)] [string] $ServiceName,
        [string] $ServiceAccount,
        [Parameter(Mandatory)] [string] $RepoRoot,
        [Parameter(Mandatory)] [string] $NssmPath,
        [Parameter(Mandatory)] [int]    $StopTimeoutMs
    )

    $nssm = Get-Command $NssmPath -ErrorAction SilentlyContinue
    if (-not $nssm) { throw "nssm.exe not found ('$NssmPath'). Install it (https://nssm.cc) and retry, or pass -NssmPath." }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'node not found on PATH. Install Node >= 22.11.0 and retry.' }

    $entry = Join-Path $RepoRoot 'dist/server.js'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
        throw "'$entry' does not exist - run 'npm run build' in $RepoRoot first."
    }

    $vars = Read-EnvFile -Path $EnvFile
    $check = Test-RequiredEnv -Vars $vars
    if (-not $check.Ok) {
        throw "EnvFile '$EnvFile' is missing: $($check.MissingFields -join ', ')"
    }

    $logDir = Join-Path $RepoRoot 'logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null

    & $nssm.Source install $ServiceName $node.Source $entry
    & $nssm.Source set $ServiceName AppDirectory $RepoRoot
    & $nssm.Source set $ServiceName AppStdout (Join-Path $logDir 'service.out.log')
    & $nssm.Source set $ServiceName AppStderr (Join-Path $logDir 'service.err.log')
    & $nssm.Source set $ServiceName AppStopMethodConsole $StopTimeoutMs
    & $nssm.Source set $ServiceName Start SERVICE_AUTO_START

    $envLines = @()
    foreach ($key in $vars.Keys) { $envLines += "$key=$($vars[$key])" }
    & $nssm.Source set $ServiceName AppEnvironmentExtra ($envLines -join "`r`n")

    if ($ServiceAccount) {
        Write-Host "Set the service's Log On As account to '$ServiceAccount' via Services.msc or 'sc.exe config $ServiceName obj= $ServiceAccount', then supply its password once through the same dialog - nssm cannot set a password non-interactively without it appearing in this process's argument list."
    }
    else {
        Write-Host "No -ServiceAccount given: the service runs as LocalSystem, which has no '.claude'/'.codex' profile of its own. Either rerun with -ServiceAccount naming an account whose profile already holds both CLIs' credential state, or set HOME/USERPROFILE in $EnvFile to point at a directory that does."
    }

    Write-Host "Installed '$ServiceName'. Start with: nssm start $ServiceName  (or Start-Service $ServiceName)"
    Write-Host "Stop with:  nssm stop $ServiceName  (or Stop-Service $ServiceName) - sends a console Ctrl event first, which src/server.ts's SIGINT handler drains and reaps children on before NSSM would escalate."
}

# Same dot-source guard as tools/Wait-PullRequestCheck.ps1: lets this script's tests
# dot-source it to exercise Read-EnvFile/Test-RequiredEnv without installing a real service.
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-Install -EnvFile $EnvFile -ServiceName $ServiceName -ServiceAccount $ServiceAccount `
        -RepoRoot $RepoRoot -NssmPath $NssmPath -StopTimeoutMs $StopTimeoutMs
}
