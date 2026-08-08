#Requires -Version 7.0
#Requires -Modules Pester

<#
  Everything here runs through -DryRun and an -StatePath inside TestDrive, so no
  session is ever launched and this repository's real state file is never
  touched. That is the whole reason -DryRun returns the plan as an object rather
  than printing it: the launch decision is testable without a launch.

  The refusals get as much coverage as the successes. A boundary check that has
  never refused anything is not known to constrain anything - five refusal cases
  are asserted below (fresh-boundary continuation, cross-vendor continuation,
  daemon verbs on claude, Create without a description, teleport on a dirty
  tree), against six accepted ones.

  Not covered: the launch itself, and the codex session-id read-back. Both need
  a real agent process to observe honestly, and a fake one would only assert
  that the mock was called.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Start-AgentSession.ps1'

    function New-State {
        <# Writes a state file and returns its path. #>
        param([hashtable]$Values)
        $path = Join-Path $TestDrive ([guid]::NewGuid().ToString() + '.json')
        $base = @{
            project = $TestDrive; lastCommand = $null; lastVendor = $null
            lastSessionId = $null; lastStartedUtc = $null; chainHead = $null; designAuthor = $null
        }
        foreach ($k in $Values.Keys) { $base[$k] = $Values[$k] }
        $base | ConvertTo-Json | Set-Content -LiteralPath $path -Encoding utf8NoBOM
        return $path
    }

    function New-EmptyState { return (Join-Path $TestDrive ([guid]::NewGuid().ToString() + '.json')) }
}

Describe 'Routing' {
    It 'sends <Command> to <ExpectedModel> at <ExpectedEffort> on claude' -ForEach @(
        @{ Command = 'design';   ExpectedModel = 'opus';   ExpectedEffort = 'high'   }
        @{ Command = 'contract'; ExpectedModel = 'opus';   ExpectedEffort = 'high'   }
        @{ Command = 'slices';   ExpectedModel = 'opus';   ExpectedEffort = 'high'   }
        @{ Command = 'slice';    ExpectedModel = 'sonnet'; ExpectedEffort = 'medium' }
        @{ Command = 'verify';   ExpectedModel = 'sonnet'; ExpectedEffort = 'medium' }
        @{ Command = 'kit-help'; ExpectedModel = 'haiku';  ExpectedEffort = 'low'    }
    ) {
        $plan = & $script:ScriptPath -Command $Command -Vendor claude -DryRun -StatePath (New-EmptyState) -Project $PSScriptRoot
        $plan.Model | Should -Be $ExpectedModel
        $plan.Effort | Should -Be $ExpectedEffort
        $plan.Arguments | Should -Contain '--model'
        $plan.Arguments | Should -Contain $ExpectedModel
    }

    It 'maps the same tiers onto codex profiles' {
        $plan = & $script:ScriptPath -Command design -Vendor codex -DryRun -StatePath (New-EmptyState) -Project $PSScriptRoot
        $plan.Model | Should -Be 'architect'
        $plan.Arguments | Should -Contain 'model_reasoning_effort=high'
    }

    It 'appends the argument to the slash command' {
        $plan = & $script:ScriptPath -Command slice -Argument S4 -Vendor claude -DryRun -StatePath (New-EmptyState) -Project $PSScriptRoot
        $plan.Prompt | Should -Be '/slice S4'
    }

    It 'carries no effort flag on claude, which has none' {
        $plan = & $script:ScriptPath -Command design -Vendor claude -DryRun -StatePath (New-EmptyState) -Project $PSScriptRoot
        $plan.Arguments | Should -Not -Contain '-c'
        $plan.Notes -join ' ' | Should -Match 'no CLI effort flag'
    }

    It 'escalates one rung and stops at xhigh' {
        $plan = & $script:ScriptPath -Command design -Vendor codex -Escalate -DryRun -StatePath (New-EmptyState) -Project $PSScriptRoot
        $plan.Effort | Should -Be 'xhigh'

        $again = & $script:ScriptPath -Command design -Vendor codex -Effort xhigh -Escalate -DryRun -StatePath (New-EmptyState) -Project $PSScriptRoot
        $again.Effort | Should -Be 'xhigh'
    }

    It 'reaches max only when max is named' {
        $plan = & $script:ScriptPath -Command design -Vendor codex -Effort max -DryRun -StatePath (New-EmptyState) -Project $PSScriptRoot -WarningAction SilentlyContinue
        $plan.Effort | Should -Be 'max'
    }

    It 'requires a tier for free text' {
        { & $script:ScriptPath -Prompt 'anything' -DryRun -StatePath (New-EmptyState) -Project $PSScriptRoot } |
            Should -Throw
    }
}

Describe 'Vendor selection' {
    It 'sends redteam to the vendor that did not write the design' {
        $state = New-State @{ designAuthor = 'claude' }
        $plan = & $script:ScriptPath -Command redteam -DryRun -StatePath $state -Project $PSScriptRoot
        $plan.Vendor | Should -Be 'codex'

        $state2 = New-State @{ designAuthor = 'codex' }
        $plan2 = & $script:ScriptPath -Command redteam -DryRun -StatePath $state2 -Project $PSScriptRoot
        $plan2.Vendor | Should -Be 'claude'
    }

    It 'warns rather than blocks when redteam must run on the design author' {
        $state = New-State @{ designAuthor = 'claude' }
        $warnings = @()
        $plan = & $script:ScriptPath -Command redteam -Vendor claude -DryRun -StatePath $state -Project $PSScriptRoot -WarningVariable warnings -WarningAction SilentlyContinue
        $plan.Vendor | Should -Be 'claude'
        $warnings -join ' ' | Should -Match 'also wrote the design'
    }

    It 'defaults everything except redteam to claude' {
        $plan = & $script:ScriptPath -Command slice -DryRun -StatePath (New-EmptyState) -Project $PSScriptRoot
        $plan.Vendor | Should -Be 'claude'
    }
}

Describe 'Session boundaries' {
    BeforeEach {
        $script:AfterSlice = New-State @{
            lastCommand = 'slice'; lastVendor = 'claude'
            lastSessionId = '11111111-2222-3333-4444-555555555555'; chainHead = 'slice'
        }
    }

    It 'keeps verify in the slice session when -Continue is passed' {
        $plan = & $script:ScriptPath -Command verify -Continue -DryRun -StatePath $script:AfterSlice -Project $PSScriptRoot
        $plan.SessionMode | Should -Be 'Same'
        $plan.SessionId | Should -Be '11111111-2222-3333-4444-555555555555'
        $plan.Arguments | Should -Contain '--resume'
    }

    It 'starts fresh without -Continue, and says the chain was available' {
        $plan = & $script:ScriptPath -Command verify -DryRun -StatePath $script:AfterSlice -Project $PSScriptRoot
        $plan.SessionMode | Should -Be 'Fresh'
        $plan.Arguments | Should -Contain '--session-id'
        $plan.Arguments | Should -Not -Contain '--resume'
    }

    It 'refuses to continue across a fresh boundary' {
        { & $script:ScriptPath -Command track -Continue -DryRun -StatePath $script:AfterSlice -Project $PSScriptRoot } |
            Should -Throw -ExpectedMessage '*session boundary*'
    }

    It 'refuses to continue a claude session on codex' {
        { & $script:ScriptPath -Command verify -Continue -Vendor codex -DryRun -StatePath $script:AfterSlice -Project $PSScriptRoot } |
            Should -Throw -ExpectedMessage '*do not cross vendors*'
    }

    It 'refuses -Continue with no recorded session' {
        { & $script:ScriptPath -Command verify -Continue -DryRun -StatePath (New-EmptyState) -Project $PSScriptRoot } |
            Should -Throw -ExpectedMessage '*session boundary*'
    }

    It 'overrides a boundary with -Force, loudly' {
        $warnings = @()
        $plan = & $script:ScriptPath -Command track -Continue -Force -DryRun -StatePath $script:AfterSlice -Project $PSScriptRoot -WarningVariable warnings -WarningAction SilentlyContinue
        $plan.SessionMode | Should -Be 'Same'
        $warnings -join ' ' | Should -Match 'overrides a session boundary'
    }

    It 'warns when a chain step is skipped' {
        $warnings = @()
        $null = & $script:ScriptPath -Command pr -Continue -DryRun -StatePath $script:AfterSlice -Project $PSScriptRoot -WarningVariable warnings -WarningAction SilentlyContinue
        $warnings -join ' ' | Should -Match 'Skipping verify'
    }

    It 'will not continue backwards along the chain' {
        $afterPr = New-State @{
            lastCommand = 'pr'; lastVendor = 'claude'
            lastSessionId = '11111111-2222-3333-4444-555555555555'; chainHead = 'slice'
        }
        { & $script:ScriptPath -Command slice -Continue -DryRun -StatePath $afterPr -Project $PSScriptRoot } |
            Should -Throw -ExpectedMessage '*fresh-session boundary*'
    }

    It 'runs the fix chain on the same tail as the slice chain' {
        $afterFix = New-State @{
            lastCommand = 'fix'; lastVendor = 'claude'
            lastSessionId = '99999999-8888-7777-6666-555555555555'; chainHead = 'fix'
        }
        $plan = & $script:ScriptPath -Command verify -Continue -DryRun -StatePath $afterFix -Project $PSScriptRoot
        $plan.SessionMode | Should -Be 'Same'
    }
}

Describe 'Remote verbs' {
    It 'maps Create onto each vendor' {
        $c = & $script:ScriptPath -Remote Create -Description 'groundwork' -Vendor claude -DryRun -Project $PSScriptRoot
        $c.CommandLine | Should -Be 'claude --remote groundwork'

        $x = & $script:ScriptPath -Remote Create -Description 'groundwork' -Vendor codex -DryRun -Project $PSScriptRoot
        $x.CommandLine | Should -Be 'codex cloud exec groundwork'
    }

    It 'maps List onto each vendor' {
        (& $script:ScriptPath -Remote List -Vendor claude -DryRun -Project $PSScriptRoot).CommandLine | Should -Be 'claude --teleport'
        (& $script:ScriptPath -Remote List -Vendor codex  -DryRun -Project $PSScriptRoot).CommandLine | Should -Be 'codex cloud list'
    }

    It 'refuses Create without a description' {
        { & $script:ScriptPath -Remote Create -Vendor claude -DryRun -Project $PSScriptRoot } |
            Should -Throw -ExpectedMessage '*needs -Description*'
    }

    It 'refuses daemon verbs on claude, which runs no daemon' -ForEach @(
        @{ Verb = 'Start' }, @{ Verb = 'Stop' }, @{ Verb = 'Pair' }
    ) {
        { & $script:ScriptPath -Remote $Verb -Vendor claude -DryRun -Project $PSScriptRoot } |
            Should -Throw -ExpectedMessage '*no local daemon*'
    }

    It 'sends daemon verbs to codex remote-control' {
        (& $script:ScriptPath -Remote Start -Vendor codex -DryRun -Project $PSScriptRoot).CommandLine |
            Should -Be 'codex remote-control start'
    }

    It 'defaults Start to codex and Create to claude' {
        (& $script:ScriptPath -Remote Start -DryRun -Project $PSScriptRoot).Vendor | Should -Be 'codex'
        (& $script:ScriptPath -Remote Create -Description 'x' -DryRun -Project $PSScriptRoot).Vendor | Should -Be 'claude'
    }

    It 'refuses codex Teleport without a session id' {
        { & $script:ScriptPath -Remote Teleport -Vendor codex -DryRun -Project $PSScriptRoot } |
            Should -Throw -ExpectedMessage '*needs -SessionId*'
    }
}

Describe 'Teleport preflight' {
    BeforeAll {
        $script:Repo = Join-Path $TestDrive 'repo'
        New-Item -ItemType Directory -Path $script:Repo -Force | Out-Null
        & git -C $script:Repo init --quiet 2>&1 | Out-Null
        & git -C $script:Repo config user.email 'test@example.com'
        & git -C $script:Repo config user.name 'Test'
        Set-Content -LiteralPath (Join-Path $script:Repo 'a.txt') -Value 'one' -Encoding utf8NoBOM
        & git -C $script:Repo add a.txt
        & git -C $script:Repo commit --quiet -m 'init' 2>&1 | Out-Null
    }

    It 'allows teleport into a clean worktree' {
        $plan = & $script:ScriptPath -Remote Teleport -SessionId abc123 -Vendor claude -DryRun -Project $script:Repo
        $plan.CommandLine | Should -Be 'claude --teleport abc123'
    }

    It 'refuses teleport over uncommitted work, before any API call' {
        Set-Content -LiteralPath (Join-Path $script:Repo 'a.txt') -Value 'two' -Encoding utf8NoBOM
        try {
            { & $script:ScriptPath -Remote Teleport -SessionId abc123 -Vendor claude -DryRun -Project $script:Repo } |
                Should -Throw -ExpectedMessage '*not clean*'
        } finally {
            & git -C $script:Repo checkout --quiet -- a.txt
        }
    }

    It 'names the offending paths in the refusal' {
        Set-Content -LiteralPath (Join-Path $script:Repo 'stray.txt') -Value 'x' -Encoding utf8NoBOM
        try {
            $message = $null
            try { & $script:ScriptPath -Remote Teleport -SessionId abc123 -Vendor claude -DryRun -Project $script:Repo }
            catch { $message = $_.Exception.Message }
            $message | Should -Match 'stray\.txt'
        } finally {
            Remove-Item (Join-Path $script:Repo 'stray.txt') -Force
        }
    }
}

Describe 'State' {
    It 'survives a corrupt state file instead of crashing on it' {
        $path = Join-Path $TestDrive 'corrupt.json'
        Set-Content -LiteralPath $path -Value '{ this is not json' -Encoding utf8NoBOM
        $warnings = @()
        $plan = & $script:ScriptPath -Command slice -DryRun -StatePath $path -Project $PSScriptRoot -WarningVariable warnings -WarningAction SilentlyContinue
        $plan.SessionMode | Should -Be 'Fresh'
        $warnings -join ' ' | Should -Match 'unreadable'
    }

    It 'writes nothing under -DryRun' {
        $path = Join-Path $TestDrive 'untouched.json'
        $null = & $script:ScriptPath -Command slice -DryRun -StatePath $path -Project $PSScriptRoot
        Test-Path -LiteralPath $path | Should -BeFalse
    }
}
