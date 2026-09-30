param(
    [switch]$Launch
)

Write-Warning "scripts/native-acceptance.ps1 is kept only as a Windows compatibility wrapper. The canonical acceptance runner is npm run acceptance:local."

if ($Launch) {
    & npm run acceptance:local -- --launch
} else {
    & npm run acceptance:local
}

exit $LASTEXITCODE
