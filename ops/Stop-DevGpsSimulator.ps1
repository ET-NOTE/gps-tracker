$stateDir = Join-Path $env:LOCALAPPDATA 'GPS-DevSimulator'
if (Test-Path -LiteralPath $stateDir) {
    New-Item -ItemType File -Path (Join-Path $stateDir 'stop.flag') -Force | Out-Null
    Write-Output 'Stop requested. The sender exits after the current HTTP request.'
}
