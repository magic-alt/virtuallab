param(
    [switch]$Launch
)

Write-Warning "scripts/native-acceptance.ps1 is kept only as a Windows compatibility wrapper. The canonical acceptance runner is scripts/acceptance.mjs."

$argsList = @("scripts/acceptance.mjs")
if ($Launch) {
    $argsList += "--launch"
}

& node @argsList
exit $LASTEXITCODE
