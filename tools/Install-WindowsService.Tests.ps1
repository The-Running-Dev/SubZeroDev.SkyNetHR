#Requires -Version 7.0
#Requires -Modules Pester

<#
  Install-WindowsService.ps1's own invocation guard (`$MyInvocation.InvocationName -ne '.'`)
  is dot-sourced here for the same reason Wait-PullRequestCheck.Tests.ps1 dot-sources its
  script: it defines Read-EnvFile/Test-RequiredEnv/Invoke-Install in this scope without
  running Invoke-Install for real - no nssm, no node, no service is ever touched by this file.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Install-WindowsService.ps1'
    $script:PreDotSourceErrorActionPreference = $ErrorActionPreference
    # Dummy value only to satisfy the Mandatory top-level -EnvFile; the guard this
    # dot-source relies on skips using it for anything.
    . $script:ScriptPath -EnvFile 'unused'
}

AfterAll {
    $ErrorActionPreference = $script:PreDotSourceErrorActionPreference
    Set-StrictMode -Off
}

Describe 'Read-EnvFile' {

    It 'parses KEY=VALUE lines, skipping blanks and comments' {
        $path = [System.IO.Path]::GetTempFileName()
        try {
            Set-Content -LiteralPath $path -Value @(
                '# a comment'
                ''
                'AUTH_MODE=shared-secret'
                'ALLOWED_ORIGINS=https://example.test'
            )
            $vars = Read-EnvFile -Path $path
            $vars['AUTH_MODE'] | Should -Be 'shared-secret'
            $vars['ALLOWED_ORIGINS'] | Should -Be 'https://example.test'
            $vars.Keys.Count | Should -Be 2
        }
        finally { Remove-Item -LiteralPath $path -Force }
    }

    It 'throws when the file does not exist' {
        { Read-EnvFile -Path 'Z:\does\not\exist.env' } | Should -Throw '*not found*'
    }

    It 'throws on a line with no =' {
        $path = [System.IO.Path]::GetTempFileName()
        try {
            Set-Content -LiteralPath $path -Value 'NOT_A_KV_LINE'
            { Read-EnvFile -Path $path } | Should -Throw '*not KEY=VALUE*'
        }
        finally { Remove-Item -LiteralPath $path -Force }
    }
}

Describe 'Test-RequiredEnv' {

    It 'passes with every always-required field plus shared-secret''s own fields set' {
        $vars = @{
            AUTH_MODE        = 'shared-secret'
            ALLOWED_ORIGINS  = 'https://example.test'
            WORKSPACE_ROOTS  = 'C:\work'
            STORAGE_ROOT     = 'C:\data'
            AUTH_COOKIE_NAME = 'skynet_hr_session'
            AUTH_SECRET      = 'dev-secret'
        }
        (Test-RequiredEnv -Vars $vars).Ok | Should -Be $true
    }

    It 'reports every missing always-required field at once, not just the first' {
        $result = Test-RequiredEnv -Vars @{ AUTH_MODE = 'shared-secret'; AUTH_COOKIE_NAME = 'x'; AUTH_SECRET = 'y' }
        $result.Ok | Should -Be $false
        $result.MissingFields | Should -Contain 'ALLOWED_ORIGINS'
        $result.MissingFields | Should -Contain 'WORKSPACE_ROOTS'
        $result.MissingFields | Should -Contain 'STORAGE_ROOT'
    }

    It 'requires proxy-header''s own field' {
        $result = Test-RequiredEnv -Vars @{
            AUTH_MODE       = 'proxy-header'
            ALLOWED_ORIGINS = 'https://example.test'
            WORKSPACE_ROOTS = 'C:\work'
            STORAGE_ROOT    = 'C:\data'
        }
        $result.Ok | Should -Be $false
        $result.MissingFields | Should -Contain 'AUTH_USER_HEADER'
    }

    It 'requires open-webui''s two fields' {
        $result = Test-RequiredEnv -Vars @{
            AUTH_MODE       = 'open-webui'
            ALLOWED_ORIGINS = 'https://example.test'
            WORKSPACE_ROOTS = 'C:\work'
            STORAGE_ROOT    = 'C:\data'
            AUTH_USER_HEADER = 'X-User-Id'
        }
        $result.Ok | Should -Be $false
        $result.MissingFields | Should -Contain 'AUTH_SESSION_HEADER'
    }

    It 'flags an unrecognised AUTH_MODE rather than silently requiring nothing extra' {
        $result = Test-RequiredEnv -Vars @{
            AUTH_MODE       = 'nonsense'
            ALLOWED_ORIGINS = 'https://example.test'
            WORKSPACE_ROOTS = 'C:\work'
            STORAGE_ROOT    = 'C:\data'
        }
        $result.Ok | Should -Be $false
        $result.MissingFields | Where-Object { $_ -like 'AUTH_MODE*' } | Should -Not -BeNullOrEmpty
    }
}

Describe 'Invoke-Install' {

    It 'refuses when nssm.exe cannot be resolved, before anything is installed' {
        $envPath = [System.IO.Path]::GetTempFileName()
        try {
            Set-Content -LiteralPath $envPath -Value 'AUTH_MODE=shared-secret'
            { Invoke-Install -EnvFile $envPath -ServiceName 'Test' -RepoRoot $PSScriptRoot `
                -NssmPath 'nssm-does-not-exist-on-this-path' -StopTimeoutMs 30000 } |
                Should -Throw '*nssm.exe not found*'
        }
        finally { Remove-Item -LiteralPath $envPath -Force }
    }
}
