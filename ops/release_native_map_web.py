"""Web-only atomic release. No API restart, environment change or DB access.

Usage: sudo python3 release_native_map_web.py STAGE EXPECTED_PREVIOUS_WEB_COMMIT
Stage contains web.tar.gz and manifest.json (sha256 per file).
"""
import hashlib
import json
import os
import pathlib
import re
import shutil
import sys
import tarfile
import urllib.request

stage = pathlib.Path(sys.argv[1]).resolve()
previous_commit = sys.argv[2]
assert stage.parent == pathlib.Path('/home/mmm/gps-artifacts')
manifest = json.loads((stage/'manifest.json').read_text())
release = manifest['release']
assert re.fullmatch(r'web-(?:native-map-20261009|sim-20261020|remediation-20261020|remediation-20261021|directions-20261022|report-design-20261023)-[a-f0-9]{7}', release)
assert re.fullmatch(r'[a-f0-9]{40}', manifest['git_commit'])
link = pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
assert link.is_symlink()
previous = link.resolve()
prior = json.loads((previous/'version.json').read_text())
assert prior['git_commit'] == previous_commit, 'Production changed; review before promotion.'
target = pathlib.Path('/home/mmm/releases')/release
assert not target.exists()
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(stage/'web.tar.gz') == manifest['archive_sha256']
get = lambda path: urllib.request.urlopen('https://gps.serial.kr'+path, timeout=20).read()
health = json.loads(get('/health'))
diagnostics = {p: hashlib.sha256(get(p)).hexdigest() for p in ['/diagnostic', '/diagnostic/device']}
target.mkdir(mode=0o755)
web = target/'web'
web.mkdir(mode=0o755)
with tarfile.open(stage/'web.tar.gz', 'r:gz') as archive:
    for member in archive.getmembers():
        dest = (web/member.name).resolve()
        assert dest.is_relative_to(web) and (member.isfile() or member.isdir())
    archive.extractall(web)
for name, digest in manifest['web_files'].items():
    path = (web/name).resolve()
    assert path.is_relative_to(web) and sha(path) == digest
assert b'"/assets/' in (web/'index.html').read_bytes(), 'Expected root Vite base.'
# Lazy imports from already-open web clients must survive a new index release.
for old in (previous/'assets').iterdir():
    if old.is_file() and not (web/'assets'/old.name).exists():
        shutil.copy2(old, web/'assets'/old.name)
if (previous/'uploads').is_symlink():
    (web/'uploads').symlink_to((previous/'uploads').resolve(), target_is_directory=True)
deployed = dict(manifest, target='production', api_release=health.get('release'),
                api_git_commit=prior.get('api_git_commit', prior['git_commit']),
                api_sha256=prior.get('api_sha256'))
(web/'version.json').write_text(json.dumps(deployed, indent=2))
(target/'previous-web.txt').write_text(str(previous)+'\n')
shutil.copy2(stage/'manifest.json', target/'build-manifest.json')
for root, dirs, files in os.walk(web):
    pathlib.Path(root).chmod(0o755)
    for name in files:
        p = pathlib.Path(root)/name
        if not p.is_symlink(): p.chmod(0o644)
next_link = link.with_name('dist-root.next-native-map')
assert not next_link.exists() and not next_link.is_symlink()
assert link.resolve() == previous, 'Production link changed during staging.'
next_link.symlink_to(web, target_is_directory=True)
os.replace(next_link, link)
try:
    assert hashlib.sha256(get('/')).hexdigest() == sha(web/'index.html')
    assert hashlib.sha256(get('/devices')).hexdigest() == sha(web/'index.html')
    assert hashlib.sha256(get('/corporate')).hexdigest() == sha(web/'index.html')
    assert json.loads(get('/version.json'))['git_commit'] == manifest['git_commit']
    assert json.loads(get('/health')).get('release') == health.get('release')
    for path, digest in diagnostics.items(): assert hashlib.sha256(get(path)).hexdigest() == digest
    # Verify each new executable chunk is actually reachable after cutover.
    for name, digest in manifest['web_files'].items():
        if name.endswith(('.js', '.css')):
            assert hashlib.sha256(get('/'+name)).hexdigest() == digest
except Exception:
    next_link.symlink_to(previous, target_is_directory=True)
    os.replace(next_link, link)
    raise
result = {'release': release, 'web_commit': manifest['git_commit'], 'api_unchanged': True,
          'diagnostics_unchanged': True, 'previous_web': str(previous), 'target': str(web)}
(target/'deployment.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
