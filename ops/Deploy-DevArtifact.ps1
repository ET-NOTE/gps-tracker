param([Parameter(Mandatory=$true)][string]$ArtifactDirectory)
$ErrorActionPreference = 'Stop'
$artifact = (Resolve-Path -LiteralPath $ArtifactDirectory).Path
$manifest = Get-Content (Join-Path $artifact 'manifest.json') -Raw | ConvertFrom-Json
$release = $manifest.release
if ($manifest.target -ne 'dev' -or $release -notmatch '^dev-[0-9]{8}-[0-9]{6}-[a-f0-9]{7}$') { throw 'Only a named dev artifact can be deployed.' }
$stage = "/home/mmm/gps-artifacts/$release"
ssh -o BatchMode=yes seriallog "mkdir -p $stage"
if ($LASTEXITCODE -ne 0) { throw 'VPS connection failed.' }
scp -q (Join-Path $artifact 'artifacts.tar.gz') "seriallog:$stage/artifacts.tar.gz"
if ($LASTEXITCODE -ne 0) { throw 'Artifact upload failed.' }
ssh -o BatchMode=yes seriallog "tar -xzf $stage/artifacts.tar.gz -C $stage && tr -d '\r' < $stage/deploy-dev-artifact.sh | bash -s -- $stage"
if ($LASTEXITCODE -ne 0) { throw 'Dev deployment failed; inspect the preflight/health output.' }
$backup = Join-Path $env:LOCALAPPDATA "GPS-PrivateBackups\$release"
New-Item -ItemType Directory -Path $backup -Force | Out-Null
ssh -o BatchMode=yes seriallog "sudo install -o mmm -g mmm -m 0600 /home/gps-dev/backups/$release/dev.dump $stage/dev-before-deploy.dump"
if ($LASTEXITCODE -ne 0) { throw 'Dev is deployed, but preparing the offsite backup failed.' }
scp -q "seriallog:$stage/dev-before-deploy.dump" (Join-Path $backup 'dev-before-deploy.dump')
if ($LASTEXITCODE -ne 0) { throw 'Dev is deployed, but downloading the offsite backup failed.' }
Write-Output "Dev deployed; pre-deployment DB backup saved outside VPS: $backup"
