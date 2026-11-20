param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot '../output/security113/terminal' }
$Host.UI.RawUI.WindowTitle = 'GPS VPS Security - Actual Server Output'
try {
    $size = $Host.UI.RawUI.BufferSize
    $size.Width = 122
    $size.Height = 300
    $Host.UI.RawUI.BufferSize = $size
    $windowSize = $Host.UI.RawUI.WindowSize
    $windowSize.Width = 122
    $windowSize.Height = 49
    $Host.UI.RawUI.WindowSize = $windowSize
} catch { }
$Host.UI.RawUI.BackgroundColor = 'Black'
$Host.UI.RawUI.ForegroundColor = 'White'
Clear-Host
python "$PSScriptRoot/show_security_terminal113.py" --output $OutputDirectory
if ($LASTEXITCODE -ne 0) { Write-Host 'Verification failed. Do not treat this as a passing result.' -ForegroundColor Red }
Read-Host 'Press Enter to close'
