param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot '../output/security114/terminal' }
$Host.UI.RawUI.WindowTitle = 'GPS Security 114 - Actual Server Output'
try {
    $size = $Host.UI.RawUI.BufferSize
    $size.Width = 126
    $size.Height = 300
    $Host.UI.RawUI.BufferSize = $size
    $windowSize = $Host.UI.RawUI.WindowSize
    $windowSize.Width = 126
    $windowSize.Height = 55
    $Host.UI.RawUI.WindowSize = $windowSize
} catch { }
$Host.UI.RawUI.BackgroundColor = 'Black'
$Host.UI.RawUI.ForegroundColor = 'White'
Clear-Host
python "$PSScriptRoot/show_security_terminal114.py" --output $OutputDirectory
if ($LASTEXITCODE -ne 0) { Write-Host 'Status check failed. Do not treat this as a passing result.' -ForegroundColor Red }
Read-Host 'Press Enter to close'
