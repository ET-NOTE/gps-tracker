"""Publish a new immutable Android APK/ZIP pair, retaining existing versions.

Usage: sudo python3 release_android_downloads.py /home/mmm/gps-artifacts/android-VERSION-CODE
No API, database, signing configuration or existing APK is modified.
"""
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

stage = pathlib.Path(sys.argv[1]).resolve()
assert stage.parent == pathlib.Path('/home/mmm/gps-artifacts')
manifest = json.loads((stage/'manifest.json').read_text())
version = manifest['version']
code = manifest['version_code']
assert re.fullmatch(r'\d+\.\d+\.\d+', version) and isinstance(code, int) and code > 0
assert re.fullmatch(r'[a-f0-9]{40}', manifest['app_commit'])
stem = f'gps-tracker-{version}-{code}'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
for ext in ('apk', 'zip'):
    assert sha(stage/f'{stem}.{ext}') == manifest[f'{ext}_sha256']
with zipfile.ZipFile(stage/f'{stem}.zip') as archive:
    assert sorted(archive.namelist()) == ['README.txt', stem+'.apk']
    assert hashlib.sha256(archive.read(stem+'.apk')).hexdigest() == manifest['apk_sha256']

get = lambda path: urllib.request.urlopen('https://gps.serial.kr'+path, timeout=90)
health = json.loads(get('/health').read())
config = pathlib.Path('/etc/nginx/sites-enabled/gps.serial.kr').resolve()
before = config.read_text()
assert f'location = /{stem}.' not in before, 'Version already published; never overwrite it.'
marker = '    # Versioned Android ZIP, independent of SPA releases.'
assert before.count(marker) == 1
blocks = ''
for ext, mime in [('zip', 'application/zip'), ('apk', 'application/vnd.android.package-archive')]:
    name = f'{stem}.{ext}'
    dest = pathlib.Path('/home/mmm/gps-downloads')/name
    if dest.exists():
        assert sha(dest) == manifest[f'{ext}_sha256'], 'Existing immutable artifact differs.'
    else:
        shutil.copy2(stage/name, dest)
    dest.chmod(0o644)
    blocks += f'''    location = /{name} {{
        alias /home/mmm/gps-downloads/{name};
        types {{ }}
        default_type {mime};
        add_header Content-Disposition 'attachment; filename="{name}"';
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header X-Content-Type-Options nosniff;
    }}

'''
backup = stage/'nginx-before.conf'
if backup.exists():
    assert backup.read_text() == before, 'Rollback baseline changed; review before retry.'
else:
    backup.write_text(before)
    backup.chmod(0o600)
assert config.read_text() == before, 'Nginx configuration changed during staging.'
try:
    config.write_text(before.replace(marker, blocks+marker))
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    for ext in ('apk', 'zip'):
        name = f'{stem}.{ext}'
        # nginx reload returns before every new worker has accepted requests.
        # Wait for the exact attachment route, not the old SPA fallback.
        for attempt in range(40):
            request = urllib.request.Request('https://gps.serial.kr/'+name, method='HEAD')
            with urllib.request.urlopen(request, timeout=20) as response:
                ready = response.status == 200 and name in (response.headers.get('Content-Disposition') or '')
            if ready: break
            time.sleep(0.25)
        assert ready, 'New attachment route did not become ready.'
        digest = hashlib.sha256()
        with get('/'+name) as response:
            assert response.status == 200 and name in response.headers['Content-Disposition']
            assert int(response.headers['Content-Length']) == (stage/name).stat().st_size
            assert response.headers['X-Content-Type-Options'] == 'nosniff'
            while chunk := response.read(1024*1024): digest.update(chunk)
        assert digest.hexdigest() == manifest[f'{ext}_sha256']
        request = urllib.request.Request('https://gps.serial.kr/'+name, headers={'Range': 'bytes=0-15'})
        with urllib.request.urlopen(request, timeout=30) as response:
            assert response.status == 206 and len(response.read()) == 16
    assert json.loads(get('/health').read())['release'] == health['release']
except Exception:
    config.write_text(before)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    raise
result = {'version': version, 'code': code, 'apk_sha256': manifest['apk_sha256'],
          'zip_sha256': manifest['zip_sha256'], 'api_unchanged': True,
          'old_downloads_preserved': True, 'range_requests_ok': True}
(stage/'deployment.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
