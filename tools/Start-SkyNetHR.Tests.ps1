#Requires -Version 7.0
#Requires -Modules Pester

<#
  Start-SkyNetHR.ps1 guards its invoking wrapper with `$MyInvocation.InvocationName -ne '.'`,
  so these tests dot-source it and exercise the functions directly - same structure as
  Test-WriteSurface.Tests.ps1 and Wait-PullRequestCheck.Tests.ps1.

  What is covered is the part that can be wrong without Docker noticing: the `.env`
  round-trip, the precedence that decides whether a second run reuses the first run's secret
  or mints a new one, and the path normalisation that keeps a Windows path from being
  reinterpreted by Compose's dotenv reader. The compose invocation itself is not mocked -
  a mock of `docker compose up` would assert only that this file and that mock agree.

  Every rule has a negative case. AGENTS.md, *Verification*: a validator that has never
  failed is not known to constrain anything.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Start-SkyNetHR.ps1'
    . $script:ScriptPath
}

Describe 'ConvertTo-ComposePath' {
    It 'returns an absolute path with forward slashes' {
        $result = ConvertTo-ComposePath -Path $TestDrive
        $result | Should -Not -Match '\\'
        [System.IO.Path]::IsPathRooted($result) | Should -BeTrue
    }

    It 'leaves no trailing slash, so `$path:/workspaces` cannot become a double slash' {
        $withSlash = (ConvertTo-ComposePath -Path $TestDrive) + '/'
        ConvertTo-ComposePath -Path $withSlash | Should -Not -Match '/$'
    }

    It 'expands an environment variable reference rather than passing it to Docker verbatim' {
        $env:SKYNET_HR_TEST_ROOT = $TestDrive
        try {
            ConvertTo-ComposePath -Path '%SKYNET_HR_TEST_ROOT%' |
                Should -Be (ConvertTo-ComposePath -Path $TestDrive)
        } finally {
            Remove-Item Env:\SKYNET_HR_TEST_ROOT -ErrorAction SilentlyContinue
        }
    }
}

Describe 'New-SkyNetHRSecret' {
    It 'produces lowercase hex of twice the requested byte count' {
        New-SkyNetHRSecret -ByteCount 32 | Should -Match '^[0-9a-f]{64}$'
    }

    It 'contains none of the characters that carry meaning in a cookie, a URL or JSON' {
        # The negative case for choosing hex over base64: the secret round-trips through a
        # Set-Cookie header and encodeURIComponent before the identity resolver compares it.
        New-SkyNetHRSecret | Should -Not -Match '[+/=;, "\\]'
    }

    It 'does not repeat across calls' {
        (New-SkyNetHRSecret) | Should -Not -Be (New-SkyNetHRSecret)
    }
}

Describe 'Read-EnvFile / Write-EnvFile' {
    It 'round-trips the values it wrote' {
        $path = Join-Path $TestDrive 'roundtrip.env'
        $values = [ordered]@{ ALPHA = 'one'; BETA = 'two' }
        Write-EnvFile -Path $path -Values $values

        $read = Read-EnvFile -Path $path
        $read['ALPHA'] | Should -Be 'one'
        $read['BETA'] | Should -Be 'two'
    }

    It 'writes UTF-8 without a BOM, which Compose would otherwise read as part of the first key' {
        $path = Join-Path $TestDrive 'nobom.env'
        Write-EnvFile -Path $path -Values ([ordered]@{ ALPHA = 'one' })

        $bytes = [System.IO.File]::ReadAllBytes($path)
        $bytes[0] | Should -Be ([byte]0x41)  # 'A', not 0xEF
    }

    It 'writes LF endings, per the house convention' {
        $path = Join-Path $TestDrive 'lf.env'
        Write-EnvFile -Path $path -Values ([ordered]@{ ALPHA = 'one'; BETA = 'two' })

        [System.IO.File]::ReadAllText($path) | Should -Not -Match "`r"
    }

    It 'preserves a Windows path verbatim rather than escaping it' {
        $path = Join-Path $TestDrive 'winpath.env'
        Write-EnvFile -Path $path -Values ([ordered]@{ WORKSPACE_ROOTS_HOST_DIR = 'D:/src/a repo' })

        (Read-EnvFile -Path $path)['WORKSPACE_ROOTS_HOST_DIR'] | Should -Be 'D:/src/a repo'
    }

    It 'keeps a value containing `=` whole' {
        $path = Join-Path $TestDrive 'equals.env'
        Write-EnvFile -Path $path -Values ([ordered]@{ TOKEN_RATES_JSON = '{"a":"b=c"}' })

        (Read-EnvFile -Path $path)['TOKEN_RATES_JSON'] | Should -Be '{"a":"b=c"}'
    }

    It 'skips comments and blank lines' {
        $path = Join-Path $TestDrive 'comments.env'
        [System.IO.File]::WriteAllText($path, "# a comment`n`nALPHA=one`n")

        $read = Read-EnvFile -Path $path
        $read.Keys.Count | Should -Be 1
        $read['ALPHA'] | Should -Be 'one'
    }

    It 'ignores a line with no `=`, rather than inventing an empty key' {
        $path = Join-Path $TestDrive 'malformed.env'
        [System.IO.File]::WriteAllText($path, "not an assignment`n=leading equals`nALPHA=one`n")

        $read = Read-EnvFile -Path $path
        $read.Keys.Count | Should -Be 1
        $read['ALPHA'] | Should -Be 'one'
    }

    It 'returns an empty map for a file that does not exist' {
        (Read-EnvFile -Path (Join-Path $TestDrive 'absent.env')).Keys.Count | Should -Be 0
    }
}

Describe 'Resolve-EnvValue' {
    BeforeEach {
        $script:existing = [ordered]@{ AUTH_SECRET = 'from-env-file' }
    }

    It 'prefers an explicit argument over the file and the default' {
        Resolve-EnvValue -Existing $script:existing -Key 'AUTH_SECRET' -Explicit 'explicit' -Default { 'generated' } |
            Should -Be 'explicit'
    }

    It 'reuses the file value when no argument is given, so a restart keeps the same login' {
        Resolve-EnvValue -Existing $script:existing -Key 'AUTH_SECRET' -Default { 'generated' } |
            Should -Be 'from-env-file'
    }

    It 'falls back to the default when the key is absent' {
        Resolve-EnvValue -Existing $script:existing -Key 'MISSING' -Default { 'generated' } |
            Should -Be 'generated'
    }

    It 'treats a present-but-blank file value as absent' {
        # The negative case for `IsNullOrWhiteSpace` over `Contains`: a hand-edited `.env`
        # with `AUTH_SECRET=` would otherwise start a container the compose file's `:?`
        # guard exists to refuse.
        $blank = [ordered]@{ AUTH_SECRET = '   ' }
        Resolve-EnvValue -Existing $blank -Key 'AUTH_SECRET' -Default { 'generated' } |
            Should -Be 'generated'
    }

    It 'treats a blank explicit argument as not supplied' {
        Resolve-EnvValue -Existing $script:existing -Key 'AUTH_SECRET' -Explicit '' -Default { 'generated' } |
            Should -Be 'from-env-file'
    }
}

Describe 'Get-CodexStateHazard' {
    It 'reports the session-state files the pinned container build may refuse to open' {
        $dir = Join-Path $TestDrive 'codex-hazard'
        New-Item -ItemType Directory -Path $dir | Out-Null
        New-Item -ItemType File -Path (Join-Path $dir 'state_5.sqlite') | Out-Null

        $found = Get-CodexStateHazard -Path $dir
        $found.Count | Should -Be 1
        $found[0] | Should -Match 'state_5\.sqlite$'
    }

    It 'reports nothing for a directory holding only auth.json and config.toml' {
        $dir = Join-Path $TestDrive 'codex-clean'
        New-Item -ItemType Directory -Path $dir | Out-Null
        New-Item -ItemType File -Path (Join-Path $dir 'auth.json') | Out-Null
        New-Item -ItemType File -Path (Join-Path $dir 'config.toml') | Out-Null

        (Get-CodexStateHazard -Path $dir).Count | Should -Be 0
    }

    It 'reports nothing for a directory that does not exist' {
        (Get-CodexStateHazard -Path (Join-Path $TestDrive 'absent-codex')).Count | Should -Be 0
    }
}

Describe 'Invoke-Compose' {
    <#
      The regression this guards: a bare `& docker compose ...` puts compose's own progress
      output on the function's pipeline, so the caller's `$code` becomes the whole build log
      with the exit code appended - which compares unequal to 0 and fails a build that
      succeeded. A PowerShell function outranks an executable of the same name in command
      resolution, so declaring one is enough to stand in for the real `docker` here.
    #>
    AfterEach {
        Remove-Item function:global:docker -ErrorAction SilentlyContinue
    }

    It 'returns the exit code alone, not compose output with the code appended' {
        function global:docker { Write-Output 'Container skynet-hr-dev Started'; $global:LASTEXITCODE = 0 }

        $code = Invoke-Compose -RepoRoot $TestDrive -Arguments @('up', '-d')
        $code | Should -BeOfType [int]
        $code | Should -Be 0
    }

    It 'surfaces a non-zero exit code' {
        function global:docker { $global:LASTEXITCODE = 17 }

        Invoke-Compose -RepoRoot $TestDrive -Arguments @('up', '-d') | Should -Be 17
    }
}

Describe 'Invoke-StartSkyNetHR' {
    It 'refuses a repository root with no docker-compose.dev.yml, before touching Docker' {
        { Invoke-StartSkyNetHR -RepoRoot $TestDrive } |
            Should -Throw '*docker-compose.dev.yml not found*'
    }
}
