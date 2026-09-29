param(
    [switch]$Launch
)

$ErrorActionPreference = "Stop"

function Run-Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host ""
    Write-Host "== $Name ==" -ForegroundColor DarkYellow
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

Run-Step "Desktop toolchain" { npm run doctor }
Run-Step "TypeScript typecheck" { npm run typecheck }
Run-Step "Frontend control tests" { npm run test:controls }
Run-Step "Frontend production build" { npm run build }
Run-Step "Rust native tests" { cargo test --manifest-path src-tauri/Cargo.toml }

Write-Host ""
Write-Host "Automated checks passed." -ForegroundColor Green
Write-Host ""
Write-Host "Desktop acceptance checklist:" -ForegroundColor DarkYellow
Write-Host "[ ] Add repository opens native folder picker and loads the selected Git repository."
Write-Host "[ ] Search filters repository/workspace lanes; Ctrl+K focuses it; Escape/clear resets it."
Write-Host "[ ] New Workspace creates an isolated branch/worktree; selecting it changes active workspace."
Write-Host "[ ] Remove Workspace refuses primary/dirty worktrees and removes a clean isolated worktree."
Write-Host "[ ] Refresh reloads Git state."
Write-Host "[ ] Terminal: Start/New tab, tab switch, typing, Ctrl+C, resize and Stop all work."
Write-Host "[ ] Run: Build/Test profile Run streams output; Stop terminates; add/remove profile works."
Write-Host "[ ] Changes/Checks/History/Overview tabs render and switch correctly."
Write-Host "[ ] Filesystem edits update repository status without manual refresh."
Write-Host ""
Write-Host "Record failures with command/output and workspace path before merging PR #2."

if ($Launch) {
    Write-Host ""
    Write-Host "Launching Tauri dev runtime..." -ForegroundColor DarkYellow
    npm run tauri:dev
}
