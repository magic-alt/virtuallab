param(
    [ValidateSet('Stress', 'Soak')][string]$Mode = 'Stress',
    [string]$EvidenceDirectory = '.virtuallab/qualification/windows'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'qualification-processes.ps1')
function Stop-QualificationProcess([Diagnostics.Process]$Process) {
    if ($Process.HasExited) { return }
    # Holding the original process handle pins its identity while taskkill
    # operates only on this supervisor-created test process and descendants.
    $pinnedHandle = $Process.Handle
    & taskkill.exe /PID $Process.Id /T /F | Out-Null
    if (!$Process.WaitForExit(10000)) { throw 'Owned qualification process did not exit after supervised termination' }
}
function Invoke-QualificationCase([string]$TestName, [string]$Label) {
    $script:caseCounter++
    $casePath = Join-Path $evidenceRoot ("case-$Label-$script:caseCounter")
    $runner = Start-Process -FilePath $testBinary -ArgumentList @('--exact', $TestName, '--nocapture') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput ($casePath + '.log') -RedirectStandardError ($casePath + '.stderr.log')
    $pinnedHandle = $runner.Handle
    if (!$runner.WaitForExit(30000)) { Stop-QualificationProcess $runner; throw "Timed out: $TestName" }
    $runner.WaitForExit()
    if ($null -eq $runner.ExitCode -or $runner.ExitCode -ne 0 -or !(Get-Content -LiteralPath ($casePath + '.log') -Raw).Contains('test result: ok. 1 passed; 0 failed;')) {
        throw "Native regression failed or selected no test: $TestName"
    }
    "$Label $TestName PASS" | Add-Content -LiteralPath $log
    $runner.Dispose()
}
$script:caseCounter = 0
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot
$evidenceRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $EvidenceDirectory))
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot '.virtuallab/qualification'))
if (!$evidenceRoot.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'EvidenceDirectory must be a child of .virtuallab/qualification'
}
New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
$runId = $Mode.ToLowerInvariant() + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$evidenceRoot = Join-Path $evidenceRoot $runId
New-Item -ItemType Directory -Path $evidenceRoot | Out-Null
Write-Host "Qualification run directory: $evidenceRoot"
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
$resultPath = Join-Path $evidenceRoot 'result.json'
$binarySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $testBinary).Hash.ToLowerInvariant()
@{runId=$runId; sourceSha=$sourceSha; binarySha256=$binarySha256; status='running'; passed=$false} |
    ConvertTo-Json | Set-Content $resultPath -Encoding utf8
try {

if ($Mode -eq 'Stress') {
    $raceTests = @(
        'run_registry::tests::competing_workers_cannot_reserve_the_same_workspace',
        'watch::tests::stopped_startup_cannot_reinstall_a_watcher',
        'watch::tests::late_older_startup_cannot_replace_newer_watcher'
    )
    $lifecycleTests = @(
        'execution::qualification::windows_terminal_stop_releases_pty_reader_without_dropping_session',
        'execution::qualification::windows_terminal_reaps_descendants_when_leader_exits_first',
        'execution::qualification::windows_startup_cursor_reply_survives_stop_before_ui_attachment',
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
            Invoke-QualificationCase $testName "race-$round"
        }
    }
    foreach ($round in 1..30) {
        foreach ($testName in $lifecycleTests) {
            Invoke-QualificationCase $testName "lifecycle-$round"
        }
        Write-Host "Lifecycle round $round/30 passed"
    }
    @{ runId=$runId; binarySha256=$binarySha256; sourceSha=$sourceSha; mode=$Mode; raceRounds=100; raceCases=3; lifecycleRounds=30; lifecycleCases=8;
       startedAt=$started.ToUniversalTime().ToString('o'); completedAt=(Get-Date).ToUniversalTime().ToString('o'); passed=$true
    } | ConvertTo-Json | Set-Content $resultPath -Encoding utf8
    exit 0
}

$soakLog = Join-Path $evidenceRoot 'soak.log'
$soakError = Join-Path $evidenceRoot 'soak-stderr.log'
$soakTest = 'execution::qualification::native_four_worktree_eight_terminal_one_hour_soak'
if (!((& $testBinary --list) -join "`n").Contains($soakTest + ': test')) { throw 'Missing ignored one-hour soak test' }
$testProcess = Start-Process -FilePath $testBinary -ArgumentList @(
    '--exact', 'execution::qualification::native_four_worktree_eight_terminal_one_hour_soak', '--ignored', '--nocapture'
) -WindowStyle Hidden -PassThru -RedirectStandardOutput $soakLog -RedirectStandardError $soakError
$pinnedHandle = $testProcess.Handle
$samples = Join-Path $evidenceRoot 'soak-resources.csv'
$owned = @{}
$rootStartedAt = $testProcess.StartTime.ToUniversalTime().ToFileTimeUtc()
$started = Get-Date
while (!$testProcess.HasExited) {
    # Only process metadata: never command lines, environment blocks, memory contents or user logs.
    $snapshot = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)
    foreach ($pin in [regex]::Matches([string](Get-Content -LiteralPath $soakLog -Raw), 'QUALIFICATION_SHELL pid=(\d+) filetime=(\d+)')) {
        $owned["$($pin.Groups[1].Value):$($pin.Groups[2].Value)"] = $true
    }
    $ids = @([uint32]$testProcess.Id) + @($owned.Keys | ForEach-Object {[uint32]($_.Split(':')[0])})
    do {
        $next = @($snapshot | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object { [uint32]$_.ProcessId })
        $ids += $next
    } while ($next.Count -gt 0)
    $metadata = @()
    foreach ($item in ($snapshot | Where-Object { $ids -contains $_.ProcessId })) {
        try {
            $process = Get-Process -Id $item.ProcessId -ErrorAction Stop
            # WMI timestamps have microsecond precision; validate the lookup
            # against the snapshot, then pin the exact kernel creation time.
            if ([math]::Abs(($process.StartTime.ToUniversalTime() - $item.CreationDate.ToUniversalTime()).TotalMilliseconds) -lt 1) {
                $metadata += [pscustomobject]@{Pid=$process.Id; ParentPid=$item.ParentProcessId;
                    StartedAt=$process.StartTime.ToUniversalTime().ToFileTimeUtc(); Process=$process}
            } else { $process.Dispose() }
        } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { }
          catch [ComponentModel.Win32Exception] { }
          catch [InvalidOperationException] { }
    }
    $selected = @(Select-OwnedQualificationSnapshot $metadata $owned $testProcess.Id $rootStartedAt)
    $processes = @($selected | ForEach-Object {$_.Process})
    $rootProcess = ($selected | Where-Object {$_.Pid -eq $testProcess.Id}).Process
    if (!$rootProcess) {
        foreach ($item in $metadata) { $item.Process.Dispose() }
        $testProcess.Refresh()
        if ($testProcess.HasExited) { break }
        throw 'Missing identity-verified resource metrics for the live qualification root'
    }
    [pscustomobject]@{
        timestamp=(Get-Date).ToUniversalTime().ToString('o'); elapsedSeconds=[math]::Round(((Get-Date)-$started).TotalSeconds,1)
        rootPid=$testProcess.Id; processes=$processes.Count
        rssBytes=($processes | Measure-Object WorkingSet64 -Sum).Sum
        privateBytes=($processes | Measure-Object PrivateMemorySize64 -Sum).Sum
        cpuSeconds=($processes | Measure-Object CPU -Sum).Sum
        threads=($processes | ForEach-Object {$_.Threads.Count} | Measure-Object -Sum).Sum
        handles=($processes | Measure-Object HandleCount -Sum).Sum
        rootRssBytes=$rootProcess.WorkingSet64; rootPrivateBytes=$rootProcess.PrivateMemorySize64
        rootThreads=$rootProcess.Threads.Count; rootHandles=$rootProcess.HandleCount; rootCpuSeconds=$rootProcess.CPU
    } | Export-Csv -LiteralPath $samples -Append -NoTypeInformation -Encoding utf8
    foreach ($item in $metadata) { $item.Process.Dispose() }
    if (((Get-Date)-$started).TotalSeconds -gt 3720) {
        Stop-QualificationProcess $testProcess
        throw 'One-hour fixture exceeded its supervised teardown deadline'
    }
    Start-Sleep -Seconds 5
    $testProcess.Refresh()
}
$testProcess.WaitForExit()
Start-Sleep -Seconds 10
$remaining = @($owned.Keys | ForEach-Object {
    $identity = $_.Split(':')
    $process = Get-Process -Id ([int]$identity[0]) -ErrorAction SilentlyContinue
    if ($process) {
        if ($process.StartTime.ToUniversalTime().ToFileTimeUtc() -eq [long]$identity[1]) { $process.Id }
        $process.Dispose()
    }
})
$elapsed = ((Get-Date)-$started).TotalSeconds
$logText = Get-Content -LiteralPath $soakLog -Raw
$pins = @([regex]::Matches($logText, 'QUALIFICATION_SHELL pid=(\d+) filetime=(\d+)') | ForEach-Object {$_.Value} | Select-Object -Unique)
$passed = (Test-QualificationSoakCompletion $testProcess.ExitCode $elapsed $logText $pins.Count) -and $remaining.Count -eq 0
$rows = @(Import-Csv $samples)
$coveragePassed = $rows.Count -ge 600 -and [double]$rows[0].elapsedSeconds -le 10 -and [double]$rows[-1].elapsedSeconds -ge 3590
$maximumGap = 0.0
for ($index = 0; $index -lt $rows.Count; $index++) {
    $row = $rows[$index]
    if ([double]$row.rootRssBytes -le 0 -or [double]$row.rootPrivateBytes -le 0 -or [int]$row.rootThreads -le 0 -or [int]$row.rootHandles -le 0) { $coveragePassed = $false }
    if ($index -gt 0) {
        $gap = [double]$row.elapsedSeconds - [double]$rows[$index-1].elapsedSeconds
        $maximumGap = [math]::Max($maximumGap, $gap)
        if ($gap -le 0 -or $gap -gt 15) { $coveragePassed = $false }
    }
}
$passed = $passed -and $coveragePassed
@{ runId=$runId; binarySha256=$binarySha256; sourceSha=$sourceSha; mode=$Mode; startedAt=$started.ToUniversalTime().ToString('o');
   completedAt=(Get-Date).ToUniversalTime().ToString('o'); exitCode=$testProcess.ExitCode;
   elapsedSeconds=$elapsed; pinnedShells=$pins.Count; sampleCount=$rows.Count; samplingCoveragePassed=$coveragePassed;
   maximumSamplingGapSeconds=$maximumGap; remainingOwnedPids=$remaining; passed=$passed
} | ConvertTo-Json | Set-Content $resultPath -Encoding utf8
if (!$passed) { throw 'Soak failed or observed owned processes survived the ten-second quiet period' }
Write-Host 'One-hour native soak passed; see SHA-bound result and resource samples.'
} catch {
    @{runId=$runId; sourceSha=$sourceSha; binarySha256=$binarySha256; status='failed'; passed=$false;
        error=$_.Exception.Message; completedAt=(Get-Date).ToUniversalTime().ToString('o')} |
        ConvertTo-Json | Set-Content $resultPath -Encoding utf8
    throw
} finally {
    if ($testProcess) {
        try { if (!$testProcess.HasExited) { Stop-QualificationProcess $testProcess } }
        finally { $testProcess.Dispose() }
    }
}
