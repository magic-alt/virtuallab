# Pure qualification logic; input contains process identity metadata only.
function Select-OwnedQualificationSnapshot {
    param([object[]]$Snapshot, [hashtable]$Owned, [int]$RootPid, [long]$RootStartedAt)
    $Owned["${RootPid}:$RootStartedAt"] = $true
    $selected = @{}
    foreach ($item in $Snapshot) {
        if ($item.Pid -le 0 -or $item.StartedAt -le 0) { throw 'Invalid process identity metadata' }
        if ($Owned.ContainsKey("$($item.Pid):$($item.StartedAt)")) { $selected[[string]$item.Pid] = $item }
    }
    do {
        $changed = $false
        foreach ($item in $Snapshot) {
            $parent = $selected[[string]$item.ParentPid]
            if (!$selected.ContainsKey([string]$item.Pid) -and $parent -and $item.StartedAt -ge $parent.StartedAt) {
                $selected[[string]$item.Pid] = $item
                $Owned["$($item.Pid):$($item.StartedAt)"] = $true
                $changed = $true
            }
        }
    } while ($changed)
    @($selected.Values)
}
function Test-QualificationSoakCompletion {
    param([Nullable[int]]$ExitCode, [double]$ElapsedSeconds, [string]$Log, [int]$PinnedShells)
    $null -ne $ExitCode -and $ExitCode -eq 0 -and $ElapsedSeconds -ge 3600 -and $PinnedShells -eq 8 -and
        $Log -match '(?m)^test result: ok\. 1 passed; 0 failed; 0 ignored;' -and
        $Log -match '(?m)^QUALIFICATION_SOAK passed elapsed_secs=(3[6-9][0-9]{2}|[4-9][0-9]{3}|[1-9][0-9]{4,}) cycles=[1-9][0-9]* readers_exited=8\r?$'
}
