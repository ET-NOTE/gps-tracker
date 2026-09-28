"""Promote the tested shield selector API + web together, without changing nginx/schema.

prepare only captures rollback material. After an offsite hash check and explicit
user approval, apply with --user-approved. No production test accounts or data.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import psycopg2

mode, release = sys.argv[1:3]
assert mode in ('prepare', 'apply')
assert re.fullmatch(r'dev-20260928-[0-9]{6}-[a-f0-9]{7}', release)
assert sys.argv[3:] == (['--user-approved'] if mode == 'apply' else [])
os.umask(0o027)
stage = Path('/home/mmm/gps-artifacts') / release
backup = Path('/home/mmm/backups') / ('gps-shield-selector-' + release)
target = Path('/home/mmm/releases') / release.replace('dev-', 'prod-', 1)
api = Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
web = Path('/home/mmm/gps-tracker-web/dist-root')
env = Path('/home/mmm/projects/gps-tracker-api/.env')
nginx = Path('/etc/nginx/sites-available/gps.serial.kr')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = json.loads((stage / 'manifest.json').read_text())
assert manifest['release'] == release and manifest['git_commit'].startswith(release.rsplit('-', 1)[1])
assert sha(stage / 'gps-tracker-api-dev') == manifest['api_sha256']
assert sha(stage / 'source.tar.gz') == manifest['source_sha256']
assert 'assets/shield-monitor.js' in manifest['web_files']
for name, digest in manifest['web_files'].items():
    path = (stage / 'web' / name).resolve()
    assert path.is_relative_to(stage / 'web') and sha(path) == digest


def get(path, host='gps.serial.kr'):
    with urllib.request.urlopen('https://' + host + path, timeout=15) as response:
        return response.read()


def status(path, expected, data=None, scheme='https'):
    request = urllib.request.Request(scheme + '://gps.serial.kr' + path,
                                     data=data, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            code = response.status
    except urllib.error.HTTPError as error:
        code = error.code
    assert code == expected, (path, code, expected)


def schema():
    values = dict(line.split('=', 1) for line in env.read_text().splitlines()
                  if '=' in line and not line.startswith('#'))
    with psycopg2.connect(values['DATABASE_URL'].strip().strip('"').strip("'")) as db:
        db.set_session(readonly=True, autocommit=True)
        with db.cursor() as cursor:
            cursor.execute("SELECT md5(string_agg(version::text||encode(checksum,'hex'),'' ORDER BY version)) FROM _sqlx_migrations")
            return cursor.fetchone()[0]


assert json.loads(get('/health', 'dev-gps.serial.kr'))['release'] == release
assert json.loads(get('/version.json', 'dev-gps.serial.kr'))['git_commit'] == manifest['git_commit']
if mode == 'prepare':
    assert not backup.exists() and web.is_symlink()
    assert json.loads(get('/health'))['release'] == 'dev-20260928-123509-e2bb6e0'
    assert json.loads(get('/version.json'))['git_commit'].startswith('18c829d')
    backup.mkdir(mode=0o700, parents=True)
    shutil.copy2(api, backup / 'api.previous')
    shutil.copytree(web.resolve(), backup / 'web.previous', symlinks=True)
    before = dict(api=sha(api), env=sha(env), nginx=sha(nginx), schema=schema(),
                  previous_web=str(web.resolve()), web_index=sha(web / 'index.html'),
                  kc={p: hashlib.sha256(get(p)).hexdigest() for p in ['/diagnostic', '/diagnostic/device']})
    (backup / 'before.json').write_text(json.dumps(before, indent=2))
    with tarfile.open(backup / 'backup.tar.gz', 'w:gz', dereference=False) as archive:
        for name in ('api.previous', 'web.previous', 'before.json'):
            archive.add(backup / name, arcname=name)
    print(json.dumps(dict(backup=str(backup), sha256=sha(backup / 'backup.tar.gz'), release=release)))
    sys.exit(0)

before = json.loads((backup / 'before.json').read_text())
assert json.loads((backup / 'offsite-verified.json').read_text())['sha256'] == sha(backup / 'backup.tar.gz')
assert sha(api) == before['api'] and sha(env) == before['env'] and sha(nginx) == before['nginx']
assert schema() == before['schema'] and str(web.resolve()) == before['previous_web']
assert sha(web / 'index.html') == before['web_index'] and not target.exists()
stat = api.stat()
target.mkdir(parents=True); target.parent.chmod(0o755)
shutil.copytree(stage / 'web', target / 'web')
# Preserve previous hashed chunks for already-open main application tabs.
for old in (web / 'assets').iterdir():
    if old.is_file() and not (target / 'web/assets' / old.name).exists():
        shutil.copy2(old, target / 'web/assets' / old.name)
assert (web / 'uploads').is_symlink()
(target / 'web/uploads').symlink_to((web / 'uploads').resolve(), target_is_directory=True)
shutil.copy2(stage / 'manifest.json', target / 'build-manifest.json')
shutil.copy2(stage / 'source.tar.gz', target / 'source.tar.gz')
(target / 'web/version.json').write_text(json.dumps(dict(manifest, target='production', build_target='dev'), indent=2))
for root, dirs, files in os.walk(target):
    Path(root).chmod(0o755)
    for name in files: (Path(root) / name).chmod(0o644)
next_api = api.with_name(api.name + '.next-selector')
next_web = web.with_name('dist-root.next-selector')
assert not next_web.exists() and not next_web.is_symlink()
shutil.copy2(stage / 'gps-tracker-api-dev', next_api)
os.chown(next_api, stat.st_uid, stat.st_gid); next_api.chmod(0o755)
try:
    # Assets first: old inline monitor does not use them; new API then finds them ready.
    next_web.symlink_to(target / 'web', target_is_directory=True); os.replace(next_web, web)
    os.replace(next_api, api)
    subprocess.run(['systemctl', 'restart', 'gps-tracker-api'], check=True)
    for attempt in range(20):
        try:
            health = json.loads(get('/health'))
            if health['release'] == release and health['environment'] == 'production' and health['db']:
                break
        except (OSError, ValueError): pass
        time.sleep(.5)
    else: raise RuntimeError('Production API health failed')
    for path, digest in before['kc'].items(): assert hashlib.sha256(get(path)).hexdigest() == digest
    assert sha(env) == before['env'] and sha(nginx) == before['nginx'] and schema() == before['schema']
    assert hashlib.sha256(get('/')).hexdigest() == sha(target / 'web/index.html')
    for name, digest in manifest['web_files'].items():
        assert hashlib.sha256(get('/' + name)).hexdigest() == digest, name
    page = get('/arduino-shield').decode()
    assert 'id="device"' in page and '/assets/shield-monitor.js?v=' + release in page
    status('/api/v1/shield-monitor/devices', 401)
    status('/api/v1/shield-monitor/devices/3015', 401)
    status('/arduino-shield/data?uid=other', 400)
    public = json.loads(get('/arduino-shield/data'))
    assert public['device_uid'] == 'uno-shield-test' and len(public['items']) <= 100
    assert all(not {'lat', 'lng', 'raw', 'iccid', 'owner_id'} & row.keys() for row in public['items'])
    for scheme in ('http', 'https'):
        status('/ingest', 400, b'{"device_uid":{}}', scheme)
        status('/ingest/shield', 400, b'{}', scheme)
    result = dict(release=release, api_sha256=sha(api), web_index_sha256=sha(web / 'index.html'),
                  kc_unchanged=True, schema_unchanged=True, nginx_unchanged=True, env_unchanged=True)
    (backup / 'deployment.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
except Exception:
    # Roll back both sides; no schema or production records were changed by this tool.
    if next_web.is_symlink(): next_web.unlink()
    next_web.symlink_to(before['previous_web'], target_is_directory=True); os.replace(next_web, web)
    shutil.copy2(backup / 'api.previous', next_api)
    os.chown(next_api, stat.st_uid, stat.st_gid); next_api.chmod(0o755)
    os.replace(next_api, api)
    subprocess.run(['systemctl', 'restart', 'gps-tracker-api'], check=True)
    raise
