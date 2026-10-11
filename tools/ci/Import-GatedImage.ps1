#Requires -Version 7.0
<#
.SYNOPSIS
    Loads the gated image saved by Invoke-ImageGate.ps1 and checks its digest.

.DESCRIPTION
    The gated image is carried between jobs, never rebuilt: its digest is asserted equal on
    both sides of the job boundary before anything is pushed. Reads image.tar and
    image-digest.txt from the current folder.

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

docker load -i image.tar

$loaded = (docker inspect -f '{{.Id}}' "skynet-hr:$Sha").Trim()
$gated = (Get-Content -Raw -Path image-digest.txt).Trim()
if ($loaded -ne $gated) {
    throw "the loaded image's digest ($loaded) does not match the gated image's digest ($gated)"
}
