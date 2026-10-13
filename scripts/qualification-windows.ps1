param(
    [ValidateSet('Stress', 'Soak')][string]$Mode = 'Stress',
    [string]$EvidenceDirectory = '.virtuallab/qualification/windows'
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot
$evidenceRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $EvidenceDirectory))
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot '.virtuallab/qualification'))
if (!$evidenceRoot.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'EvidenceDirectory must be a child of .virtuallab/qualification'
}
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
$cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
$cargoExecutable = if ($cargoCommand) { $cargoCommand.Source } else {
    Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cargo/bin/cargo.exe'
}
$artifactLog = Join-Path $evidenceRoot 'test-artifacts.jsonl'
& $cargoExecutable test --locked --manifest-path src-tauri/Cargo.toml --no-run --message-format=json > $artifactLog
if ($LASTEXITCODE -ne 0) { throw 'Native qualification test compilation failed' }
$artifacts = Get-Content -LiteralPath $artifactLog | ForEach-Object { $_ | ConvertFrom-Json }
$testBinary = ($artifacts | Where-Object {
    $_.reason -eq 'compiler-artifact' -and $_.target.name -eq 'virtuallab_lib' -and $_.profile.test -and $_.executable
} | Select-Object -Last 1).executable
if (!$testBinary) { throw 'Could not resolve the native library test executable' }
$sourceSha = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve qualification source SHA' }
if ((& git status --porcelain).Count -gt 0) { throw 'Commit qualification sources before collecting SHA-bound evidence' }

if ($Mode -eq 'Stress') {
    $raceTests = @(
        'run_registry::tests::competing_workers_cannot_reserve_the_same_workspace',
        'watch::tests::stopped_startup_cannot_reinstall_a_watcher',
        'watch::tests::late_older_startup_cannot_replace_newer_watcher'
    )
    $lifecycleTests = @(
        'execution::qualification::windows_terminal_stop_releases_pty_reader_without_dropping_session',
        'execution::qualification::windows_terminal_reaps_descendants_when_leader_exits_first',
        'execution::tests::windows_default_shell_accepts_commands_through_native_conpty',
        'managed_process::tests::stop_reaps_tree_and_closes_descendant_output_pipes',
        'managed_process::tests::exited_leader_does_not_leave_descendants_holding_output_open',
        'verification::tests::cancellation_cleans_descendants_before_joining_readers',
        'verification::tests::timeout_cleans_descendants_before_joining_readers'
    )
    $listedTests = (& $testBinary --list) -join "`n"
    foreach ($testName in ($raceTests + $lifecycleTests)) {
        if (!$listedTests.Contains($testName + ': test')) { throw "Missing qualification test: $testName" }
    }
    $log = Join-Path $evidenceRoot 'stress.log'
    $started = Get-Date
    foreach ($round in 1..100) {
        foreach ($testName in $raceTests) {
            & $testBinary --exact $testName --nocapture >> $log 2>&1
            if ($LASTEXITCODE -ne 0) { throw "Race round $round failed: $testName" }
        }
    }
    foreach ($round in 1..30) {
        foreach ($testName in $lifecycleTests) {
            & $testBinary --exact $testName --nocapture >> $log 2>&1
            if ($LASTEXITCODE -ne 0) { throw "Lifecycle round $round failed: $testName" }
        }
        Write-Host "Lifecycle round $round/30 passed"
    }
    @{ sourceSha=$sourceSha; mode=$Mode; raceRounds=100; raceCases=3; lifecycleRounds=30; lifecycleCases=7;
       startedAt=$started.ToUniversalTime().ToString('o'); completedAt=(Get-Date).ToUniversalTime().ToString('o'); passed=$true
    } | ConvertTo-Json | Set-Content (Join-Path $evidenceRoot 'stress-result.json') -Encoding utf8
    exit 0
}

$soakLog = Join-Path $evidenceRoot 'soak.log'
$soakError = Join-Path $evidenceRoot 'soak-stderr.log'
$testProcess = Start-Process -FilePath $testBinary -ArgumentList @(
    '--exact', 'execution::qualification::native_four_worktree_eight_terminal_one_hour_soak', '--ignored', '--nocapture'
) -WindowStyle Hidden -PassThru -RedirectStandardOutput $soakLog -RedirectStandardError $soakError
$samples = Join-Path $evidenceRoot 'soak-resources.csv'
$owned = @{}
$started = Get-Date
while (!$testProcess.HasExited) {
    # Only process metadata: never command lines, environment blocks, memory contents or user logs.
    $snapshot = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)
    $ids = @([uint32]$testProcess.Id)
    do {
        $next = @($snapshot | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object { [uint32]$_.ProcessId })
        $ids += $next
    } while ($next.Count -gt 0)
    $processes = @()
    foreach ($item in ($snapshot | Where-Object { $ids -contains $_.ProcessId })) {
        try {
            $process = Get-Process -Id $item.ProcessId -ErrorAction Stop
            $owned[[string]$process.Id] = $process.StartTime.ToUniversalTime().Ticks
            $processes += $process
        } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { }
    }
    [pscustomobject]@{
        timestamp=(Get-Date).ToUniversalTime().ToString('o'); elapsedSeconds=[math]::Round(((Get-Date)-$started).TotalSeconds,1)
        rootPid=$testProcess.Id; processes=$processes.Count
        rssBytes=($processes | Measure-Object WorkingSet64 -Sum).Sum
        privateBytes=($processes | Measure-Object PrivateMemorySize64 -Sum).Sum
        cpuSeconds=($processes | Measure-Object CPU -Sum).Sum
        threads=($processes | ForEach-Object {$_.Threads.Count} | Measure-Object -Sum).Sum
        handles=($processes | Measure-Object HandleCount -Sum).Sum
    } | Export-Csv -LiteralPath $samples -Append -NoTypeInformation -Encoding utf8
    Start-Sleep -Seconds 5
    $testProcess.Refresh()
}
$testProcess.WaitForExit()
Start-Sleep -Seconds 10
$remaining = @($owned.Keys | ForEach-Object {
    $process = Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.ToUniversalTime().Ticks -eq $owned[$_]) { $process.Id }
})
$passed = $testProcess.ExitCode -eq 0 -and $remaining.Count -eq 0
@{ sourceSha=$sourceSha; mode=$Mode; startedAt=$started.ToUniversalTime().ToString('o');
   completedAt=(Get-Date).ToUniversalTime().ToString('o'); exitCode=$testProcess.ExitCode;
   sampleCount=@(Import-Csv $samples).Count; remainingOwnedPids=$remaining; passed=$passed
} | ConvertTo-Json | Set-Content (Join-Path $evidenceRoot 'soak-result.json') -Encoding utf8
if (!$passed) { throw 'Soak failed or observed owned processes survived the ten-second quiet period' }
Write-Host 'One-hour native soak passed; see SHA-bound result and resource samples.'
