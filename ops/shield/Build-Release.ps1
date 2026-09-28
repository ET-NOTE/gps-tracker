param([string]$Runner = 'etcom-hub')
$ErrorActionPreference = 'Stop'
if ($Runner -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]*$') { throw 'Use a configured SSH alias.' }
$repository = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Push-Location $repository
try {
    if (git status --porcelain) { throw 'Commit the reviewed source before packaging.' }
    $commit = (git rev-parse HEAD).Trim()
    $release = 'shield-{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $commit.Substring(0,7)
    $output = Join-Path $env:LOCALAPPDATA "GPS-Builds\$release"
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    $archive = Join-Path $output 'source.tar.gz'
    git archive --format=tar.gz --output=$archive HEAD gps-tracker-api shield-web ops/shield
    if ($LASTEXITCODE -ne 0) { throw 'Source archive failed.' }
    $entries = tar -tf $archive
    if ($entries | Where-Object { $_ -match '(^|/)(\.env|preview\.env|ui-fixture\.json)($|/)' }) { throw 'Private file in source.' }
    $remote = "build/gps-tracker/shield-releases/$release"
    ssh -o BatchMode=yes $Runner "mkdir -p $remote/src $remote/output"
    if ($LASTEXITCODE -ne 0) { throw 'Runner connection failed.' }
    scp -q $archive "${Runner}:$remote/source.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw 'Source transfer failed.' }
    ssh -o BatchMode=yes $Runner "tar -xzf $remote/source.tar.gz -C $remote/src"
    if ($LASTEXITCODE -ne 0) { throw 'Source extraction failed.' }
    ssh -o BatchMode=yes $Runner "bash $remote/src/ops/shield/build-on-hub.sh $release $commit"
    if ($LASTEXITCODE -ne 0) { throw 'Build failed; nothing deployed.' }
    scp -q "${Runner}:$remote/output/$release.tar.gz" $output
    if ($LASTEXITCODE -ne 0) { throw 'Artifact transfer failed.' }
    scp -q "${Runner}:$remote/output/$release.tar.gz.sha256" $output
    if ($LASTEXITCODE -ne 0) { throw 'Checksum transfer failed.' }
    $expected = (Get-Content (Join-Path $output "$release.tar.gz.sha256") -Raw).Split(' ')[0]
    $actual = (Get-FileHash (Join-Path $output "$release.tar.gz") -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw 'Artifact checksum mismatch.' }
    Write-Output "Shield release verified: $output"
    Write-Output "SHA256: $actual"
} finally { Pop-Location }
