param([double]$DurationHours = 24)
$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'GPS-DevSimulator'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$scriptPath = Join-Path $PSScriptRoot 'dev_gps_simulator.py'
$pythonPath = (Get-Command python.exe -ErrorAction Stop).Source
$arguments = '"{0}" --state-dir "{1}" --duration-hours {2}' -f $scriptPath, $stateDir, $DurationHours
$process = Start-Process -FilePath $pythonPath -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $stateDir 'process-error.log')
Start-Sleep -Seconds 2
if ($process.HasExited) { throw (Get-Content (Join-Path $stateDir 'process-error.log') -Raw) }
Write-Output "Dev GPS sender PID=$($process.Id); state=$stateDir; duration=$DurationHours hours"
