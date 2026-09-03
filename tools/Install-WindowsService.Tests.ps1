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

Describe 'Set-ServiceEnvironment' {

    # HKCU, not the real HKLM service key: writable without elevation and disposable. The
    # function takes the key path precisely so this test never touches a real service.
    BeforeEach {
        $script:TestKey = "HKCU:\Software\SkyNetHRTests\$(New-Guid)"
        New-Item -Path $script:TestKey -Force | Out-Null
    }

    AfterEach {
        if (Test-Path -LiteralPath $script:TestKey) {
            Remove-Item -LiteralPath $script:TestKey -Recurse -Force
        }
    }

    It 'writes every KEY=VALUE as REG_MULTI_SZ and round-trips them' {
        $vars = @{ AUTH_MODE = 'shared-secret'; AUTH_SECRET = 'sekrit'; STORAGE_ROOT = 'C:\data' }

        Set-ServiceEnvironment -Vars $vars -ParametersKey $script:TestKey

        $written = (Get-ItemProperty -LiteralPath $script:TestKey -Name 'AppEnvironmentExtra').AppEnvironmentExtra
        $written | Should -Contain 'AUTH_MODE=shared-secret'
        $written | Should -Contain 'AUTH_SECRET=sekrit'
        $written | Should -Contain 'STORAGE_ROOT=C:\data'
        $written.Count | Should -Be 3
    }

    It 'stores the value as MultiString, not as a single joined string' {
        Set-ServiceEnvironment -Vars @{ A = '1'; B = '2' } -ParametersKey $script:TestKey

        $kind = (Get-Item -LiteralPath $script:TestKey).GetValueKind('AppEnvironmentExtra')
        $kind | Should -Be ([Microsoft.Win32.RegistryValueKind]::MultiString)
    }

    It 'throws, rather than silently skipping the write, when the parameters key is absent' {
        { Set-ServiceEnvironment -Vars @{ A = '1' } -ParametersKey "HKCU:\Software\SkyNetHRTests\$(New-Guid)" } |
            Should -Throw '*does not exist*'
    }

    It 'throws when the read-back does not match, and names only field names - never a value' {
        # The guard's own negative case. Set-ItemProperty is mocked to a no-op and the key
        # pre-seeded with something else, so the read-back legitimately disagrees with what
        # the function believes it wrote - the silent-misconfiguration case this exists for.
        Set-ItemProperty -LiteralPath $script:TestKey -Name 'AppEnvironmentExtra' `
            -Value ([string[]]@('SOMETHING=else')) -Type MultiString
        Mock Set-ItemProperty { }

        { Set-ServiceEnvironment -Vars @{ AUTH_SECRET = 'sekrit' } -ParametersKey $script:TestKey } |
            Should -Throw '*does not match*'

        # The secret must not reach the operator's console via the failure path either.
        $err = { Set-ServiceEnvironment -Vars @{ AUTH_SECRET = 'sekrit' } -ParametersKey $script:TestKey } |
            Should -Throw -PassThru
        "$err" | Should -Not -Match 'sekrit'
        "$err" | Should -Match 'AUTH_SECRET'
    }

    It 'a value containing = survives: only the first = separates key from value' {
        Set-ServiceEnvironment -Vars @{ TOKEN_RATES_JSON = '{"a":1}'; PADDED = 'x=y=z' } -ParametersKey $script:TestKey

        $written = (Get-ItemProperty -LiteralPath $script:TestKey -Name 'AppEnvironmentExtra').AppEnvironmentExtra
        $written | Should -Contain 'PADDED=x=y=z'
    }
}

Describe 'Get-ServiceParametersKey' {

    It 'points at the named service''s own NSSM parameters key' {
        Get-ServiceParametersKey -ServiceName 'SkyNetHR' |
            Should -Be 'HKLM:\SYSTEM\CurrentControlSet\Services\SkyNetHR\Parameters'
    }
}

Describe 'Invoke-Nssm' {

    # A fake "nssm.exe" that just exits with $env:FAKE_NSSM_EXIT_CODE - no real nssm needed
    # to exercise the exit-status check itself.
    BeforeAll {
        $script:FakeNssm = Join-Path ([System.IO.Path]::GetTempPath()) "fake-nssm-$(New-Guid).cmd"
        Set-Content -LiteralPath $script:FakeNssm -Value @(
            '@echo off'
            'echo fake nssm failure 1>&2'
            'exit /b %FAKE_NSSM_EXIT_CODE%'
        )
    }

    AfterAll { Remove-Item -LiteralPath $script:FakeNssm -Force -ErrorAction SilentlyContinue }

    It 'throws, naming the exit code, when the command exits nonzero' {
        $env:FAKE_NSSM_EXIT_CODE = '3'
        try {
            { Invoke-Nssm -Nssm $script:FakeNssm -Arguments @('set', 'Test', 'Bogus', 'x') } |
                Should -Throw '*exit 3*'
        }
        finally { Remove-Item Env:\FAKE_NSSM_EXIT_CODE -ErrorAction SilentlyContinue }
    }

    It 'does not throw when the command exits zero' {
        $env:FAKE_NSSM_EXIT_CODE = '0'
        try {
            { Invoke-Nssm -Nssm $script:FakeNssm -Arguments @('set', 'Test', 'Bogus', 'x') } |
                Should -Not -Throw
        }
        finally { Remove-Item Env:\FAKE_NSSM_EXIT_CODE -ErrorAction SilentlyContinue }
    }
}

Describe 'Test-NssmNoConsole' {

    BeforeEach {
        $script:TestKey = "HKCU:\Software\SkyNetHRTests\$(New-Guid)"
        New-Item -Path $script:TestKey -Force | Out-Null
    }

    AfterEach {
        if (Test-Path -LiteralPath $script:TestKey) {
            Remove-Item -LiteralPath $script:TestKey -Recurse -Force
        }
    }

    It 'is $false when the parameters key does not exist yet' {
        Test-NssmNoConsole -ParametersKey "HKCU:\Software\SkyNetHRTests\$(New-Guid)" | Should -Be $false
    }

    It 'is $false when the key exists but AppNoConsole was never set' {
        Test-NssmNoConsole -ParametersKey $script:TestKey | Should -Be $false
    }

    It 'is $false when AppNoConsole is explicitly 0' {
        New-ItemProperty -LiteralPath $script:TestKey -Name 'AppNoConsole' -Value 0 -PropertyType DWord | Out-Null
        Test-NssmNoConsole -ParametersKey $script:TestKey | Should -Be $false
    }

    It 'is $true when AppNoConsole is nonzero' {
        New-ItemProperty -LiteralPath $script:TestKey -Name 'AppNoConsole' -Value 1 -PropertyType DWord | Out-Null
        Test-NssmNoConsole -ParametersKey $script:TestKey | Should -Be $true
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

    It 'refuses when nssm rejects a command, rather than reporting success' {
        # The missing-executable case above is Get-Command failing before nssm ever runs.
        # This is the other half (#233): nssm resolves and runs, but rejects one of the six
        # `nssm set`/`install` calls - the case $ErrorActionPreference = 'Stop' does not
        # catch, because a nonzero native exit is not a PowerShell terminating error.
        $envPath = [System.IO.Path]::GetTempFileName()
        $repoRoot = Join-Path ([System.IO.Path]::GetTempPath()) "skynet-hr-test-$(New-Guid)"
        $fakeNssm = Join-Path ([System.IO.Path]::GetTempPath()) "fake-nssm-$(New-Guid).cmd"
        try {
            New-Item -ItemType Directory -Force -Path (Join-Path $repoRoot 'dist') | Out-Null
            Set-Content -LiteralPath (Join-Path $repoRoot 'dist/server.js') -Value '// unused'
            # Fails the first call (`install`) so nothing past it ever runs for real.
            Set-Content -LiteralPath $fakeNssm -Value @('@echo off', 'exit /b 1')

            Set-Content -LiteralPath $envPath -Value @(
                'AUTH_MODE=shared-secret'
                'ALLOWED_ORIGINS=https://example.test'
                'WORKSPACE_ROOTS=C:\work'
                'STORAGE_ROOT=C:\data'
                'AUTH_COOKIE_NAME=skynet_hr_session'
                'AUTH_SECRET=dev-secret'
            )
            Mock Get-ServiceParametersKey { "HKCU:\Software\SkyNetHRTests\$(New-Guid)" }

            { Invoke-Install -EnvFile $envPath -ServiceName 'Test' -RepoRoot $repoRoot `
                -NssmPath $fakeNssm -StopTimeoutMs 30000 } |
                Should -Throw '*exit 1*'
        }
        finally {
            Remove-Item -LiteralPath $envPath -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $repoRoot -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $fakeNssm -Force -ErrorAction SilentlyContinue
        }
    }

    It 'refuses to install over a service that already has AppNoConsole set' {
        # Get-ServiceParametersKey is mocked to a disposable HKCU key rather than the real
        # HKLM service key, the same reason Set-ServiceEnvironment's own tests use HKCU:
        # writable without elevation. nssm and dist/server.js are faked so every earlier
        # guard in Invoke-Install passes and this actually reaches the AppNoConsole check -
        # nssm itself is never invoked, since the throw happens before any `& $nssm` call.
        $envPath = [System.IO.Path]::GetTempFileName()
        $repoRoot = Join-Path ([System.IO.Path]::GetTempPath()) "skynet-hr-test-$(New-Guid)"
        $fakeNssm = Join-Path ([System.IO.Path]::GetTempPath()) "fake-nssm-$(New-Guid).cmd"
        $fakeParamsKey = "HKCU:\Software\SkyNetHRTests\$(New-Guid)"
        try {
            New-Item -ItemType Directory -Force -Path (Join-Path $repoRoot 'dist') | Out-Null
            Set-Content -LiteralPath (Join-Path $repoRoot 'dist/server.js') -Value '// unused'
            Set-Content -LiteralPath $fakeNssm -Value @('@echo off', 'exit /b 0')

            Set-Content -LiteralPath $envPath -Value @(
                'AUTH_MODE=shared-secret'
                'ALLOWED_ORIGINS=https://example.test'
                'WORKSPACE_ROOTS=C:\work'
                'STORAGE_ROOT=C:\data'
                'AUTH_COOKIE_NAME=skynet_hr_session'
                'AUTH_SECRET=dev-secret'
            )
            New-Item -Path $fakeParamsKey -Force | Out-Null
            New-ItemProperty -LiteralPath $fakeParamsKey -Name 'AppNoConsole' -Value 1 -PropertyType DWord | Out-Null
            Mock Get-ServiceParametersKey { $fakeParamsKey }

            { Invoke-Install -EnvFile $envPath -ServiceName 'Test' -RepoRoot $repoRoot `
                -NssmPath $fakeNssm -StopTimeoutMs 30000 } |
                Should -Throw '*AppNoConsole*'
        }
        finally {
            Remove-Item -LiteralPath $envPath -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $repoRoot -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $fakeNssm -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $fakeParamsKey) { Remove-Item -LiteralPath $fakeParamsKey -Recurse -Force }
        }
    }
}
