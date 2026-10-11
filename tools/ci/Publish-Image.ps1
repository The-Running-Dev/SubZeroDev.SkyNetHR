#Requires -Version 7.0
<#
.SYNOPSIS
    Pushes the gated image to GHCR: always the immutable per-commit tag, and `latest` only
    while this commit is still the tip of main.

.DESCRIPTION
    Needs the image loaded as `skynet-hr:<sha>` (Import-GatedImage.ps1), a docker login to
    GHCR, and `gh` authenticated through GH_TOKEN. Reads GITHUB_REPOSITORY and
    GITHUB_REPOSITORY_OWNER, and writes a short summary to GITHUB_STEP_SUMMARY when set.

.PARAMETER Sha
    Commit SHA the image is tagged with. Defaults to IMAGE_SHA.
#>
[CmdletBinding()]
param(
    [string] $Sha = $env:IMAGE_SHA
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

if (-not $Sha) { throw 'Pass -Sha or set IMAGE_SHA.' }

function Add-Summary([string[]] $Lines) {
    if ($env:GITHUB_STEP_SUMMARY) { Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value $Lines }
}

$local = "skynet-hr:$Sha"
$image = "ghcr.io/$($env:GITHUB_REPOSITORY_OWNER.ToLowerInvariant())/skynet-hr"

# #199: pushed unconditionally, every run, regardless of what `main` has done since - this is
# the tag "three rapidly verified commits each receive their immutable image tag" is about, and
# it must never be skipped just because a later commit has since landed. No tag is announced
# until the push has succeeded and the tag resolves in the registry, the same read-back
# SubZeroDev.com's `publish-release` job makes.
docker tag $local "${image}:$Sha"
docker push "${image}:$Sha"
docker manifest inspect "${image}:$Sha" | Out-Null
Add-Summary '### Image pushed', "``${image}:$Sha``"

# #199: `:latest` is the one thing here that must reflect an *order*, and neither this
# workflow's own concurrency group (scoped per-commit) nor `workflow_run`'s completion order
# guarantees one run for an older commit cannot finish this step after a newer commit's run
# already has - `verify.yml` for an older commit can simply take longer. So this asks the one
# thing that is never stale: `main`'s actual current tip, via the API, right before the push -
# not "newer than the last one I saw" (which a crashed/restarted runner could get wrong) but
# "still this commit, right now".
#
# Validation scenario (no automated workflow test exists for this - GitHub Actions itself is
# the thing under test, and this repository has no workflow-execution harness to run one
# against without a new CI dependency): push commit A, then immediately push commit B, with
# A's `verify` run made slower than B's (e.g. temporarily widen a test's sleep) - B's publish
# run reaches this step first and tags `:latest`; A's reaches it later, reads `main` at B's
# SHA, sees a mismatch against its own sha, and skips. `docker manifest inspect
# ghcr.io/.../skynet-hr:latest` after both runs finish must resolve to B's digest, and A's own
# per-commit tag must still exist unchanged.
$tip = (gh api "repos/$($env:GITHUB_REPOSITORY)/commits/main" --jq .sha).Trim()
if ($tip -ne $Sha) {
    Write-Host "main is now at $tip, not this run's $Sha - leaving :latest alone"
    Add-Summary '### latest left unchanged', "main has moved to ``$tip`` since this commit was verified - only its immutable ``:$Sha`` tag was pushed."
    return
}

docker tag $local "${image}:latest"
docker push "${image}:latest"
docker manifest inspect "${image}:latest" | Out-Null
Add-Summary '### latest updated', "``${image}:latest`` now resolves to ``$Sha``."
