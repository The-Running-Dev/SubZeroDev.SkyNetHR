#Requires -Version 7.0
#Requires -Modules Pester

<#
  Invoke-Housekeeping.ps1 is the no-model wrapper issue #183 asks for: it must auto-delete an
  ordinary merged branch without anyone deciding anything, and it must hand off - Escalate:true,
  nothing deleted for that branch - the moment Invoke-DoneHousekeeping.ps1 itself reports a
  judgement case. Both are exercised end-to-end against real git repos under $TestDrive, the
  same "not worth mocking" reasoning Invoke-DoneHousekeeping.Tests.ps1 gives for its own script.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Invoke-Housekeeping.ps1'

    function New-GitRepo {
        param([Parameter(Mandatory)][string] $Path)
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
        & git init --quiet -b main $Path | Out-Null
        & git -C $Path -c user.email='test@example.com' -c user.name='Test' commit --allow-empty --quiet -m 'initial' | Out-Null
        $Path
    }

    function New-MergedBranch {
        # A real merge commit, so it shows up in `--merged` and Invoke-Housekeeping should
        # delete it without anyone being asked - the ordinary, no-judgement case.
        param([Parameter(Mandatory)][string] $RepoPath, [Parameter(Mandatory)][string] $Branch)
        & git -C $RepoPath checkout --quiet -b $Branch | Out-Null
        & git -C $RepoPath -c user.email='test@example.com' -c user.name='Test' commit --allow-empty --quiet -m 'feature work' | Out-Null
        & git -C $RepoPath checkout --quiet main | Out-Null
        & git -C $RepoPath -c user.email='test@example.com' -c user.name='Test' merge --no-ff --quiet $Branch -m "merge $Branch" | Out-Null
    }

    function New-UnmergedBranch {
        param([Parameter(Mandatory)][string] $RepoPath, [Parameter(Mandatory)][string] $Branch)
        & git -C $RepoPath checkout --quiet -b $Branch | Out-Null
        & git -C $RepoPath -c user.email='test@example.com' -c user.name='Test' commit --allow-empty --quiet -m 'squashed work' | Out-Null
        & git -C $RepoPath checkout --quiet main | Out-Null
        (& git -C $RepoPath rev-parse $Branch).Trim()
    }

    function New-FakeGh {
        # Same stub Invoke-DoneHousekeeping.Tests.ps1 uses: Invoke-Housekeeping.ps1 shells out
        # to Invoke-DoneHousekeeping.ps1, which shells out to `gh` directly - no seam to Mock,
        # so a stub named `gh` goes first on PATH instead.
        param([Parameter(Mandatory)][string] $BinDir)
        New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
        $stub = @'
param()
$argv = $args
$headIdx = [array]::IndexOf($argv, '--head')
$branch = if ($headIdx -ge 0) { $argv[$headIdx + 1] } else { $null }
if ($branch -and $branch -eq $env:FAKE_GH_BRANCH) {
    $oid = $env:FAKE_GH_HEAD_OID
    Write-Output "[{""number"":1,""url"":""https://example.invalid/pr/1"",""mergeCommit"":{""oid"":""abc123""},""headRefOid"":""$oid""}]"
} else {
    Write-Output '[]'
}
exit 0
'@
        Set-Content -LiteralPath (Join-Path $BinDir 'gh.ps1') -Value $stub -Encoding utf8NoBOM
        $BinDir
    }
}

Describe 'Invoke-Housekeeping' {

    Context 'the ordinary case - a merged branch, no judgement needed' {

        It 'deletes it and reports Escalate:false, with no model call in the path' {
            $repo = New-GitRepo -Path (Join-Path $TestDrive 'repo-ordinary')
            New-MergedBranch -RepoPath $repo -Branch 'feature/ordinary'

            $result = & $script:ScriptPath -RepoRoot $repo -DefaultBranch main -SkipPull

            $result.Escalate | Should -Be $false
            $result.Applied.Deleted | Should -Contain 'feature/ordinary'
            (& git -C $repo branch --list 'feature/ordinary') | Should -BeNullOrEmpty
        }
    }

    Context 'a real judgement case - commits a merged PR does not account for' {

        BeforeEach {
            $script:SavedPath = $env:PATH
            $script:Bin = New-FakeGh -BinDir (Join-Path $TestDrive ([guid]::NewGuid().ToString('n')))
            $env:PATH = "$script:Bin$([IO.Path]::PathSeparator)$env:PATH"
            $env:FAKE_GH_BRANCH = 'fix/ahead'
        }

        AfterEach {
            $env:PATH = $script:SavedPath
            Remove-Item Env:FAKE_GH_BRANCH -ErrorAction SilentlyContinue
            Remove-Item Env:FAKE_GH_HEAD_OID -ErrorAction SilentlyContinue
        }

        It 'hands off - Escalate:true, TipAheadOfMergedPr named, branch left alone - instead of guessing' {
            $repo = New-GitRepo -Path (Join-Path $TestDrive 'repo-judgement')
            $mergedHead = New-UnmergedBranch -RepoPath $repo -Branch 'fix/ahead'
            $env:FAKE_GH_HEAD_OID = $mergedHead
            # One more commit after the PR merged - the case Invoke-DoneHousekeeping.ps1
            # refuses to force-delete because no merged PR accounts for it.
            & git -C $repo checkout --quiet 'fix/ahead' | Out-Null
            & git -C $repo -c user.email='test@example.com' -c user.name='Test' commit --allow-empty --quiet -m 'after the merge' | Out-Null
            & git -C $repo checkout --quiet main | Out-Null

            $result = & $script:ScriptPath -RepoRoot $repo -DefaultBranch main -SkipPull

            $result.Escalate | Should -Be $true
            $named = $result.Discover.TipAheadOfMergedPr | Where-Object Branch -eq 'fix/ahead'
            $named | Should -Not -BeNullOrEmpty
            $named.Reason | Should -Match 'no merged PR accounts for'
            (& git -C $repo rev-parse --verify 'fix/ahead' 2>$null) | Should -Not -BeNullOrEmpty
        }
    }
}
