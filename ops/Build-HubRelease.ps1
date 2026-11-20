param([string]$Runner = 'etcom-hub')
$ErrorActionPreference = 'Stop'
if ($Runner -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]*$') { throw 'Use a configured SSH host alias.' }
$repo = Split-Path $PSScriptRoot -Parent
Push-Location $repo
try {
    if (git status --porcelain) { throw 'Commit the intended source before building a traceable release.' }
    $commit = (git rev-parse HEAD).Trim()
    $release = 'dev-{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $commit.Substring(0,7)
    $output = Join-Path $env:LOCALAPPDATA "GPS-Builds\$release"
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    $archive = Join-Path $output 'source.tar.gz'
    git archive --format=tar.gz --output=$archive HEAD gps-tracker-api gps-tracker-web ops
    if ($LASTEXITCODE -ne 0) { throw 'Source archive failed.' }
    $entries = tar -tf $archive
    if ($entries | Where-Object { $_ -match '/\.env($|\.)' -and $_ -notmatch '/\.env\.example$' }) { throw 'Environment file in build input.' }
    $remote = "build/gps-tracker/incoming/$release"
    ssh -o BatchMode=yes $Runner "mkdir -p $remote"
    if ($LASTEXITCODE -ne 0) { throw 'Runner connection failed.' }
    scp -q $archive "${Runner}:$remote/source.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw 'Source transfer failed.' }
    scp -q (Join-Path $PSScriptRoot 'hub-build.sh') "${Runner}:$remote/hub-build.sh"
    if ($LASTEXITCODE -ne 0) { throw 'Runner script transfer failed.' }
    ssh -o BatchMode=yes $Runner "tr -d '\r' < $remote/hub-build.sh | nice -n 10 ionice -c3 bash -s -- $release $commit"
    if ($LASTEXITCODE -ne 0) { throw 'Hub build failed; nothing deployed.' }
    scp -q "${Runner}:$remote/artifacts.tar.gz" (Join-Path $output 'artifacts.tar.gz')
    if ($LASTEXITCODE -ne 0) { throw 'Artifact transfer failed.' }
    tar -xzf (Join-Path $output 'artifacts.tar.gz') -C $output
    if ($LASTEXITCODE -ne 0) { throw 'Artifact extraction failed.' }
    $manifest = Get-Content (Join-Path $output 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.git_commit -ne $commit) { throw 'Source commit mismatch.' }
    foreach ($pair in @(@('gps-tracker-api-dev','api_sha256'), @('source.tar.gz','source_sha256'))) {
        if ((Get-FileHash (Join-Path $output $pair[0]) -Algorithm SHA256).Hash.ToLower() -ne $manifest.($pair[1])) { throw 'Artifact hash mismatch.' }
    }
    Write-Output "Hub build verified. Artifact directory: $output"
} finally { Pop-Location }
