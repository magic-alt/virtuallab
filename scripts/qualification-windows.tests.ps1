$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'qualification-processes.ps1')
function Assert-Qualification($condition, [string]$message) {
    if (!$condition) { throw $message }
}
$owned = @{ '10:100' = $true; '20:110' = $true }
$snapshot = @(
    [pscustomobject]@{Pid=20; ParentPid=15; StartedAt=110},
    [pscustomobject]@{Pid=30; ParentPid=20; StartedAt=120},
    [pscustomobject]@{Pid=40; ParentPid=99; StartedAt=120}
)
$selected = @(Select-OwnedQualificationSnapshot $snapshot $owned 10 100)
Assert-Qualification (($selected.Pid -contains 20) -and ($selected.Pid -contains 30) -and ($selected.Pid -notcontains 40)) 'Pinned orphan and its later child must remain owned'
$reused = @([pscustomobject]@{Pid=10; ParentPid=1; StartedAt=500}, [pscustomobject]@{Pid=50; ParentPid=10; StartedAt=510})
Assert-Qualification (@(Select-OwnedQualificationSnapshot $reused $owned 10 100).Count -eq 0) 'Reused root PID must not adopt unrelated processes'
$inverted = @([pscustomobject]@{Pid=10; ParentPid=1; StartedAt=100}, [pscustomobject]@{Pid=60; ParentPid=10; StartedAt=90})
Assert-Qualification (@(Select-OwnedQualificationSnapshot $inverted @{ '10:100'=$true } 10 100).Count -eq 1) 'A child cannot predate its selected parent'
$valid = "QUALIFICATION_SOAK passed elapsed_secs=3601 cycles=700 readers_exited=8`ntest result: ok. 1 passed; 0 failed; 0 ignored;"
Assert-Qualification (Test-QualificationSoakCompletion 0 3610 $valid 8) 'Completed one-hour fixture should pass'
Assert-Qualification (!(Test-QualificationSoakCompletion 0 10 $valid 8)) 'Short workload must not pass as one hour'
Assert-Qualification (!(Test-QualificationSoakCompletion 0 3610 'test result: ok. 0 passed; 0 failed;' 0)) 'Zero selected tests must fail'
Assert-Qualification (!(Test-QualificationSoakCompletion 0 3610 $valid 7)) 'All eight terminal identities must be pinned'
Assert-Qualification (!(Test-QualificationSoakCompletion 1 3610 $valid 8)) 'Failed native test must fail qualification'
Assert-Qualification (!(Test-QualificationSoakCompletion $null 3610 $valid 8)) 'Missing native exit code must fail qualification'
Write-Host 'Qualification metadata and completion checks: 9 passed'
