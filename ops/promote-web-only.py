"""Promote a reviewed GPS web artifact; preserve API, environment and KC routes.

Usage: python3 promote-web-only.py RELEASE EXPECTED_PREVIOUS_RELEASE
The caller must already have deployment authorization. No service restart or DB access.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request

release, expected = sys.argv[1:]
assert re.fullmatch(r'gps-web-\d{8}-\d{6}-[a-f0-9]{7}', release)
stage = Path('/home/mmm/gps-artifacts') / release
target = Path('/home/mmm/releases') / release
web = Path('/home/mmm/gps-tracker-web/dist-root')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()

def get(route):
    with urllib.request.urlopen('https://gps.serial.kr' + route, timeout=20) as response:
        assert response.status == 200
        return response.read()

def snapshot():
    paths = ['/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api',
             '/home/mmm/projects/gps-tracker-api/.env']
    paths += [str(p) for p in sorted(Path('/etc/nginx/sites-enabled').iterdir()) if p.is_file()]
    return dict(files={p: sha(Path(p)) for p in paths},
                service=subprocess.check_output(['systemctl', 'show', 'gps-tracker-api',
                  '--property=MainPID', '--property=ExecMainStartTimestamp'], text=True),
                kc={p: hashlib.sha256(get(p)).hexdigest() for p in ['/diagnostic', '/diagnostic/device']})

manifest = json.loads((stage / 'manifest.json').read_text())
assert manifest['release'] == release and manifest['component'] == 'web'
assert manifest['git_commit'].startswith(release.rsplit('-', 1)[1])
assert sha(stage / 'source.tar.gz') == manifest['source_sha256']
for name, digest in manifest['web_files'].items():
    p = (stage / 'web' / name).resolve()
    assert p.is_relative_to(stage / 'web') and sha(p) == digest
assert web.is_symlink() and not target.exists()
previous = web.resolve()
assert previous.is_relative_to('/home/mmm/releases')
current = json.loads(get('/version.json'))
assert current['release'] == expected
assert sha(previous / 'index.html') == current['web_files']['index.html']
before = snapshot()
get('/health')
target.mkdir(mode=0o755)
shutil.copytree(stage / 'web', target / 'web')
# Retain hashed chunks and existing upload links for already-open app sessions.
for p in (previous / 'assets').iterdir():
    if p.is_file() and not (target / 'web/assets' / p.name).exists():
        shutil.copy2(p, target / 'web/assets' / p.name)
if (previous / 'uploads').is_symlink():
    (target / 'web/uploads').symlink_to((previous / 'uploads').resolve(), target_is_directory=True)
shutil.copy2(stage / 'source.tar.gz', target / 'source.tar.gz')
shutil.copy2(stage / 'manifest.json', target / 'build-manifest.json')
(target / 'before.json').write_text(json.dumps(before, indent=2))
(target / 'previous-web.txt').write_text(str(previous))
version = dict(manifest, target='production', previous_release=expected,
               api_sha256=before['files']['/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api'])
(target / 'web/version.json').write_text(json.dumps(version, indent=2))
for root, dirs, files in os.walk(target, followlinks=False):
    Path(root).chmod(0o755)
    for name in files:
        p = Path(root) / name
        if not p.is_symlink(): p.chmod(0o644)
next_link = web.with_name('dist-root.next-web')
assert not next_link.exists() and not next_link.is_symlink()
next_link.symlink_to(target / 'web', target_is_directory=True)
os.replace(next_link, web)
try:
    assert json.loads(get('/version.json'))['release'] == release
    assert hashlib.sha256(get('/')).hexdigest() == manifest['web_files']['index.html']
    for name, digest in manifest['web_files'].items():
        if name.startswith('assets/') and name.endswith(('.js', '.css')):
            assert hashlib.sha256(get('/' + name)).hexdigest() == digest
    get('/health')
    after = snapshot()
    assert before == after, 'Protected API, configuration or KC pages changed'
    (target / 'verification.json').write_text(json.dumps(dict(release=release, previous_web=str(previous),
        api_unchanged=True, kc_unchanged=True, services_restarted=False, assets_verified=True), indent=2))
except BaseException:
    next_link.symlink_to(previous, target_is_directory=True)
    os.replace(next_link, web)
    raise
print((target / 'verification.json').read_text())
