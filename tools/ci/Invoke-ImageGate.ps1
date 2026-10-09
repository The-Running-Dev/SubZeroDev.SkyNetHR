#Requires -Version 7.0
<#
.SYNOPSIS
    Builds the deployment image, smoke-tests the running container, and saves the gated image.

.DESCRIPTION
    The image gate of .github/workflows/publish.yml. The image is built and tested once, then
    saved as image.tar with its digest in image-digest.txt, so the job that pushes loads that
    same tarball rather than rebuilding: what gets pushed is provably what got gated.

    Needs Docker and a free port 3000. Run it from the repository root.

.PARAMETER Sha
    Commit SHA the image is tagged with, as `skynet-hr:<sha>`. Defaults to IMAGE_SHA.
#>
[CmdletBinding()]
param(
    [string] $Sha = $env:IMAGE_SHA
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (-not $Sha) { throw 'Pass -Sha or set IMAGE_SHA.' }

$image = "skynet-hr:$Sha"
$volume = 'skynet-hr-smoke-storage'
$workspace = Join-Path ([System.IO.Path]::GetTempPath()) 'skynet-hr-workspace'

docker build -t $image .

# Minimal config to clear src/config/index.ts's fail-closed startup checks (S2.8): shared-secret
# needs no reverse proxy, and a loopback-only bind needs no TRUST_PROXY entry. No claude CLI
# credential is mounted - this smoke test only proves the server starts and binds; it never
# drives a real turn.
#
# `/data` is a Docker-managed volume, never a host bind mount: a bind mount keeps the host
# directory's ownership, and the runner user is uid 1001 while the image runs as uid 1000
# (`node`), so the Dockerfile's `chown node:node /data` would be masked and `createStore`
# (src/store/index.ts) would fail EACCES on `mkdir /data/sessions` before the server ever binds.
# A fresh named volume inherits the image's ownership. `/workspaces` stays a bind mount - it is
# only ever read.
New-Item -ItemType Directory -Force -Path $workspace | Out-Null
docker volume create $volume | Out-Null
try {
    docker run -d --name skynet-hr `
        -p 3000:3000 `
        -e BIND_HOST=0.0.0.0 `
        -e AUTH_MODE=shared-secret `
        -e AUTH_COOKIE_NAME=skynet_hr_session `
        -e AUTH_SECRET=image-gate-smoke-test `
        -e WORKSPACE_ROOTS=/workspaces `
        -e STORAGE_ROOT=/data `
        -v "${workspace}:/workspaces" `
        -v "${volume}:/data" `
        $image | Out-Null

    # Any HTTP response means the server is bound and answering; a refused connection throws.
    $answered = $false
    foreach ($attempt in 1..30) {
        try {
            Invoke-WebRequest -Uri 'http://localhost:3000/' -SkipHttpErrorCheck -TimeoutSec 5 | Out-Null
            $answered = $true
            break
        }
        catch { Start-Sleep -Seconds 1 }
    }
    if (-not $answered) {
        docker logs skynet-hr 2>&1 | Write-Host
        throw 'the container never answered on :3000'
    }

    # #198: the check above only proves the server binds; it says nothing about whether the
    # *other* half of the two-vendor contract (src/adapters/index.ts's `VENDORS`) is actually
    # reachable in the published artifact. Both CLIs answer `--help`/`exec --help`/
    # `app-server --help` with no credential mounted (that is what the Codex adapter's own
    # transport probe, `probeOk` in src/adapters/codex/index.ts, relies on), so this proves the
    # executable is on PATH and responsive without needing a real credential in CI.
    docker exec skynet-hr codex --version
    docker exec skynet-hr codex exec --help | Out-Null
}
finally {
    # Cleanup must not mask the failure that got here when the container was never created.
    $PSNativeCommandUseErrorActionPreference = $false
    docker rm -f skynet-hr | Out-Null
    docker volume rm -f $volume | Out-Null
}

docker inspect -f '{{.Id}}' $image | Set-Content -Path image-digest.txt -NoNewline
docker save $image -o image.tar
