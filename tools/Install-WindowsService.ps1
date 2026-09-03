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

    Graceful shutdown is INTENDED to reach the same code path as the container's SIGTERM
    handling (src/server.ts's `stop()`), through a different signal: Node does not reliably
    receive SIGTERM from the Windows service manager, but it does receive SIGINT from a
    console Ctrl event, which `server.ts` already listens for (`process.on('SIGINT', ...)`,
    added for the same local Ctrl+C case). NSSM's default stop sequence tries a console
    control event first, before escalating through WM_CLOSE, WM_QUIT and finally
    TerminateProcess. -StopTimeoutMs sets how long it waits at that first step.

    That route works: NSSM gives the child a console (2.24 allocates one for inheritance,
    newer builds use CREATE_NEW_CONSOLE) and on stop attaches to it and raises CTRL_C_EVENT.
    This script does not disable any of that, and never sets AppNoConsole - and refuses to
    install over an existing service that already has AppNoConsole set (Test-NssmNoConsole),
    since that is the one configuration this script's own route depends on not being true.

    It is still worth confirming once per host, because the route is configuration-dependent
    in a way that fails silently. NSSM 2.24 is documented as unable to launch services on
    newer Windows without AppNoConsole=1, and that setting removes the console the Ctrl+C
    route needs - every stop then escalates to TerminateProcess, skipping `stop()`'s drain,
    `manager.shutdown()` and the lock release, while the SCM still reports a clean stop. This
    script does not attempt to detect that case by parsing the resolved nssm.exe's own
    version: NSSM documents no command-line way to query it, and picking an admissibility
    rule without one would be guessing at a policy this repository's own convention (AGENTS.md
    "Stop if... bring it back rather than picking a floor unilaterally") says not to make
    unilaterally. Tracked as issue #233's open item; every *other* nssm call's exit status is
    now checked (Invoke-Nssm), so a rejected command fails the install instead of continuing
    past it silently.

    The check: stop the service, then look for `<STORAGE_ROOT>\server.lock`. A shutdown that
    reached `stop()` removes it (D175, asserted by src/server.test.ts's S27.12); a hard kill
    leaves it and the next boot logs a stale-lock reclaim (S22.3). Invoke-Install prints this
    on success. The observation is tracked as issue #232.

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
    ADVISORY ONLY - this script does not set the service account, and naming one here changes
    nothing but the instructions printed on success. Setting it non-interactively means
    passing a password on a command line, which is the one exposure this script exists to
    avoid (see Set-ServiceEnvironment). Run `sc.exe config` or Services.msc yourself.

    Given a value, the printed instructions name that account. Omitted, they explain that the
    service will run as LocalSystem, which has no `.claude`/`.codex` profile of its own.

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

function Invoke-Nssm {
    <# Runs one `nssm <args>` call and throws if it exits nonzero. $ErrorActionPreference =
       'Stop' does not do this for a native command - a nonzero exit from an .exe is not a
       terminating error to PowerShell, only a value left in $LASTEXITCODE, so every call
       below the missing-executable check that "throws" today actually just prints NSSM's
       own error and carries on to Set-ServiceEnvironment and the "Installed" message. #>
    param(
        [Parameter(Mandatory)] [string]   $Nssm,
        [Parameter(Mandatory)] [string[]] $Arguments
    )
    $output = & $Nssm @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "nssm $($Arguments -join ' ') failed (exit $LASTEXITCODE): $output"
    }
}

function Test-NssmNoConsole {
    <# $true when the named service already has AppNoConsole set to a nonzero REG_DWORD.
       Absent key or absent value both mean "not set" - NSSM's own documented default is to
       allocate a console, so no value present is not the dangerous state. #>
    param([Parameter(Mandatory)] [string] $ParametersKey)

    if (-not (Test-Path -LiteralPath $ParametersKey)) { return $false }
    $prop = Get-ItemProperty -LiteralPath $ParametersKey -Name 'AppNoConsole' -ErrorAction SilentlyContinue
    if (-not $prop) { return $false }
    return [bool]$prop.AppNoConsole
}

function Get-ServiceParametersKey {
    <# Where NSSM keeps its per-service settings. Separated so the tests can exercise
       Set-ServiceEnvironment against a writable HKCU key instead of HKLM. #>
    param([Parameter(Mandatory)] [string] $ServiceName)
    "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
}

function Set-ServiceEnvironment {
    <# Writes AppEnvironmentExtra directly to the registry rather than through
       `nssm set <svc> AppEnvironmentExtra ...`.

       The block contains AUTH_SECRET under shared-secret mode - the credential that
       authenticates every operator (src/config/index.ts's parseAuth). A command line is not
       a private channel on Windows: it is readable through Win32_Process.CommandLine, and
       captured by Sysmon Event ID 1 and PowerShell script-block logging. That is the same
       exposure this script refuses to accept for the service account's password, and the
       secret deserves the same treatment.

       The write is read back and compared before returning, so a wrong assumption about
       NSSM's registry layout fails loudly here rather than leaving a service that starts
       with no configuration and refuses every request at boot. Neither the comparison nor
       its failure message ever echoes a value. #>
    param(
        [Parameter(Mandatory)] [hashtable] $Vars,
        [Parameter(Mandatory)] [string]    $ParametersKey
    )

    if (-not (Test-Path -LiteralPath $ParametersKey)) {
        throw "Expected NSSM's parameters key at '$ParametersKey' and it does not exist. Either 'nssm install' did not run, or this NSSM version stores its settings elsewhere - do not assume the environment was written."
    }

    $lines = [string[]]@(foreach ($key in ($Vars.Keys | Sort-Object)) { "$key=$($Vars[$key])" })
    Set-ItemProperty -LiteralPath $ParametersKey -Name 'AppEnvironmentExtra' -Value $lines -Type MultiString

    $readBack = [string[]]@((Get-ItemProperty -LiteralPath $ParametersKey -Name 'AppEnvironmentExtra' -ErrorAction Stop).AppEnvironmentExtra)

    # Never `$matches` - that is PowerShell's automatic regex variable, and this repository
    # has already fixed two defects caused by reading it when it held something else (#227,
    # #228). A local of that name shadows it for every later reader in the same scope.
    $isMatch = $readBack.Count -eq $lines.Count
    if ($isMatch) {
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($readBack[$i] -ne $lines[$i]) { $isMatch = $false; break }
        }
    }
    if (-not $isMatch) {
        $names = (($lines | ForEach-Object { ($_ -split '=', 2)[0] }) -join ', ')
        throw "Read-back of AppEnvironmentExtra at '$ParametersKey' does not match what was written (fields: $names). The service is left holding whatever the registry now contains - remove it and retry."
    }
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

    $paramsKey = Get-ServiceParametersKey -ServiceName $ServiceName
    if (Test-NssmNoConsole -ParametersKey $paramsKey) {
        throw "Service '$ServiceName' already has AppNoConsole set. That removes the console the Ctrl+C stop route needs (see this script's own header comment), so every stop would skip src/server.ts's graceful shutdown and still report success. Remove the AppNoConsole value (or the existing service) before installing over it."
    }

    $logDir = Join-Path $RepoRoot 'logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null

    Invoke-Nssm -Nssm $nssm.Source -Arguments @('install', $ServiceName, $node.Source, $entry)
    Invoke-Nssm -Nssm $nssm.Source -Arguments @('set', $ServiceName, 'AppDirectory', $RepoRoot)
    Invoke-Nssm -Nssm $nssm.Source -Arguments @('set', $ServiceName, 'AppStdout', (Join-Path $logDir 'service.out.log'))
    Invoke-Nssm -Nssm $nssm.Source -Arguments @('set', $ServiceName, 'AppStderr', (Join-Path $logDir 'service.err.log'))
    Invoke-Nssm -Nssm $nssm.Source -Arguments @('set', $ServiceName, 'AppStopMethodConsole', $StopTimeoutMs)
    Invoke-Nssm -Nssm $nssm.Source -Arguments @('set', $ServiceName, 'Start', 'SERVICE_AUTO_START')

    Set-ServiceEnvironment -Vars $vars -ParametersKey $paramsKey

    if ($ServiceAccount) {
        Write-Host "This script does not set the service account - run: sc.exe config $ServiceName obj= $ServiceAccount password= <password>, or set it through Services.msc. Passing the password here would put it in this process's argument list, which is the exact exposure Set-ServiceEnvironment above exists to avoid for AUTH_SECRET."
    }
    else {
        Write-Host "No -ServiceAccount given: the service runs as LocalSystem, which has no '.claude'/'.codex' profile of its own. Either rerun with -ServiceAccount naming an account whose profile already holds both CLIs' credential state, or set HOME/USERPROFILE in $EnvFile to point at a directory that does."
    }

    Write-Host "Installed '$ServiceName'. Start with: nssm start $ServiceName  (or Start-Service $ServiceName)"
    Write-Host ''
    Write-Host "Before trusting this deployment, verify the stop path once (see README, 'Running it on Windows'):"
    Write-Host "  1. nssm start $ServiceName, open a session, then nssm stop $ServiceName"
    Write-Host "  2. Test-Path '$(Join-Path $vars['STORAGE_ROOT'] 'server.lock')'  ->  must be False"
    Write-Host "A True there means the stop did NOT reach src/server.ts's handler - the graceful path was skipped and the next boot will log a stale-lock reclaim. Check whether AppNoConsole is set on this service first, then record the result on issue #232."
}

# Same dot-source guard as tools/Wait-PullRequestCheck.ps1: lets this script's tests
# dot-source it to exercise Read-EnvFile/Test-RequiredEnv without installing a real service.
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-Install -EnvFile $EnvFile -ServiceName $ServiceName -ServiceAccount $ServiceAccount `
        -RepoRoot $RepoRoot -NssmPath $NssmPath -StopTimeoutMs $StopTimeoutMs
}
