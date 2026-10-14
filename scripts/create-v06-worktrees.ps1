# Creates two actual local Git worktrees for the V0.6 PR stack.
# Use in an existing clone after both branches have been pushed to GitHub.
# No force checkout, branch reset, stash, clean or deletion is performed.
[CmdletBinding()]
param(
    [string]$Repository = ".",
    [string]$WorktreeParent = ""
)

$ErrorActionPreference = "Stop"
$resolved = (git -C $Repository rev-parse --show-toplevel 2>&1)
if ($LASTEXITCODE -ne 0) { throw "Repository is not a Git checkout: $Repository" }
$root = ($resolved | Select-Object -First 1).Trim()
if (-not $WorktreeParent) {
    $WorktreeParent = Join-Path (Split-Path $root -Parent) ".virtuallab-v06-worktrees"
}
New-Item -ItemType Directory -Force -Path $WorktreeParent | Out-Null

$definitions = @(
    @{ Branch = "feat/v0.6-a-journal-recovery-p0"; Folder = "journal-recovery" },
    @{ Branch = "feat/v0.6-b-workspace-lifecycle-p0"; Folder = "workspace-lifecycle" }
)
foreach ($item in $definitions) {
    $branchName = $item.Branch
    $target = Join-Path $WorktreeParent $item.Folder

    git -C $root fetch origin $branchName
    if ($LASTEXITCODE -ne 0) { throw "Cannot fetch origin/$branchName" }

    if (Test-Path -LiteralPath $target) {
        # Never reuse a directory without verifying its registered worktree branch.
        $found = git -C $target rev-parse --abbrev-ref HEAD 2>$null
        if ($LASTEXITCODE -ne 0 -or ($found | Select-Object -First 1).Trim() -ne $branchName) {
            throw "Target directory already exists and is not the requested worktree: $target"
        }
        Write-Host "Already registered: $branchName -> $target"
        continue
    }

    git -C $root show-ref --verify --quiet "refs/heads/$branchName"
    if ($LASTEXITCODE -eq 0) {
        git -C $root worktree add $target $branchName
    } else {
        git -C $root worktree add -b $branchName $target "origin/$branchName"
    }
    if ($LASTEXITCODE -ne 0) { throw "Failed to create worktree for $branchName" }
    Write-Host "Created: $branchName -> $target"
}
git -C $root worktree list
