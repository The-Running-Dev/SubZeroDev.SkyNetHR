#Requires -Version 7.0
#Requires -Modules Pester

<#
  Invoke-DoneHousekeeping.ps1 has no exit-calling wrapper - it runs to completion and
  returns its report object on the pipeline - so these tests invoke it end-to-end via `&`
  against real git repos under $TestDrive, including a real second `git worktree`, the same
  "not worth mocking" reasoning Sync-Kit.Tests.ps1 gives for its own script.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Invoke-DoneHousekeeping.ps1'

    function New-GitRepo {
        param([Parameter(Mandatory)][string] $Path)
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
        & git init --quiet -b main $Path | Out-Null
        & git -C $Path -c user.email='test@example.com' -c user.name='Test' commit --allow-empty --quiet -m 'initial' | Out-Null
        $Path
    }

    function New-MergedWorktreeBranch {
        # Creates 'feature/foo' off main, merges it back into main with a real merge
        # commit (so it shows up in --merged without being a fast-forward no-op), then
        # checks it out in a second worktree - reproducing the '+ feature/foo' decoration
        # `git branch --merged` only adds to a branch checked out somewhere other than the
        # current worktree.
        param([Parameter(Mandatory)][string] $RepoPath, [Parameter(Mandatory)][string] $WorktreePath)
        & git -C $RepoPath checkout --quiet -b feature/foo | Out-Null
        & git -C $RepoPath -c user.email='test@example.com' -c user.name='Test' commit --allow-empty --quiet -m 'feature work' | Out-Null
        & git -C $RepoPath checkout --quiet main | Out-Null
        & git -C $RepoPath -c user.email='test@example.com' -c user.name='Test' merge --no-ff --quiet feature/foo -m 'merge feature/foo' | Out-Null
        & git -C $RepoPath worktree add --quiet $WorktreePath feature/foo *>$null
    }
}

Describe 'Invoke-DoneHousekeeping' {

    Context 'a merged branch checked out in another worktree' {

        It 'parses to its bare name in Candidates, not the "+ " decoration git branch --merged adds' {
            $repo = New-GitRepo -Path (Join-Path $TestDrive 'repo-candidates')
            $wt = Join-Path $TestDrive 'wt-candidates'
            New-MergedWorktreeBranch -RepoPath $repo -WorktreePath $wt

            $result = & $script:ScriptPath -RepoRoot $repo -DefaultBranch main -SkipPull

            $result.Stopped | Should -Be $false
            $branchNames = @($result.Candidates | ForEach-Object Branch)
            $branchNames | Should -Contain 'feature/foo'
            $branchNames | Should -Not -Contain '+ feature/foo'
        }

        It 'is refused on delete with a reason naming the blocking worktree path, distinct from a not-merged refusal' {
            $repo = New-GitRepo -Path (Join-Path $TestDrive 'repo-delete')
            $wt = Join-Path $TestDrive 'wt-delete'
            New-MergedWorktreeBranch -RepoPath $repo -WorktreePath $wt

            $result = & $script:ScriptPath -RepoRoot $repo -DefaultBranch main -SkipPull -DeleteBranches 'feature/foo'

            $result.Deleted | Should -Not -Contain 'feature/foo'
            $refusal = $result.Refused | Where-Object Branch -eq 'feature/foo'
            $refusal | Should -Not -BeNullOrEmpty
            # git's own "used by worktree at '<path>'" output always uses forward slashes,
            # even on Windows where $wt (built from $TestDrive) uses backslashes - normalise
            # both sides before comparing rather than asserting on separator-sensitive text.
            $refusal.Reason.Replace('\', '/') | Should -Match ([regex]::Escape($wt.Replace('\', '/')))
            $refusal.Reason | Should -Not -Match "Not in --merged"
        }

        It 'is deleted once the blocking worktree is removed' {
            $repo = New-GitRepo -Path (Join-Path $TestDrive 'repo-clean')
            $wt = Join-Path $TestDrive 'wt-clean'
            New-MergedWorktreeBranch -RepoPath $repo -WorktreePath $wt
            & git -C $repo worktree remove --force $wt | Out-Null

            $result = & $script:ScriptPath -RepoRoot $repo -DefaultBranch main -SkipPull -DeleteBranches 'feature/foo'

            $result.Deleted | Should -Contain 'feature/foo'
            @($result.Refused | Where-Object Branch -eq 'feature/foo') | Should -BeNullOrEmpty
        }
    }

    Context 'resolving the default branch from git remote show origin' {

        It 'resolves the first HEAD branch line, not whichever one a collection -match happens to leave in $Matches' {
            # A single matching line collapses to a scalar via PowerShell's own pipeline
            # unwrapping, so -match on it sets $Matches correctly even with the bug present -
            # that edge case alone would not catch the regression. The real failure needs
            # $headLine to stay a genuine array (2+ matching lines): `-match` against a
            # collection only filters, it never sets $Matches, so the buggy resolver reads
            # whatever $Matches was last left holding by Where-Object's OWN internal -match
            # calls while filtering - the LAST matching line, not deterministically the real
            # HEAD branch line. `git remote show origin` never emits two "HEAD branch:" lines
            # on its own, so shim `git` for that one subcommand to force the array, and pass
            # every other invocation straight through to the real binary so the rest of the
            # script still exercises a real repo.
            function git {
                # Invoke-Git always prepends '-C', $WorkingDir ahead of the real
                # subcommand, so match on the trailing args rather than a fixed index.
                if (($args -join ' ') -match 'remote show origin$') {
                    "* remote origin"
                    "  HEAD branch: main"
                    "  HEAD branch: stale-old-branch"
                    return
                }
                & git.exe @args
            }

            $repo = New-GitRepo -Path (Join-Path $TestDrive 'repo-defaultbranch')

            # Seed $Matches with stale data from an unrelated regex match, mimicking a match
            # that ran earlier in the same process - e.g. Get-WorktreeBlockingPath's own
            # "used by worktree at '...'" pattern, or a PowerShell profile's git-branch prompt.
            # (Where-Object's own filtering overwrites this before the buggy line even runs -
            # the two distinct HEAD-branch lines above are what actually exposes the defect.)
            $null = "used by worktree at '/some/unrelated/path'" -match "used by worktree at '([^']+)'"

            $result = & $script:ScriptPath -RepoRoot $repo -SkipPull

            $result.DefaultBranch | Should -Be 'main'
        }
    }
}
