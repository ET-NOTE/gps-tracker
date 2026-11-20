"""Pinned connection-notice release. Run as root after the private clone backup.

Only migration 68 is new. A separately built predecessor with migration 68 is
required for rollback; rolling back never drops reports or financial receipts.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import urllib.parse
import psycopg2

MODE = sys.argv[1]
assert MODE in ('validate', 'rollback-check', 'promote')
RELEASE = 'dev-20261009-152034-2cb78a7'
COMMIT = '2cb78a73258b563e006b2220b29c98f6ce510d24'
stage = pathlib.Path('/home/mmm/gps-artifacts') / RELEASE
backup = pathlib.Path('/home/mmm/backups/gps-connection-20261009')
target = pathlib.Path('/home/mmm/releases') / RELEASE.replace('dev-', 'prod-', 1)
api = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
web = pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
env_path = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
nginx = pathlib.Path('/etc/nginx/sites-available/gps.serial.kr')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = json.loads((stage / 'manifest.json').read_text())
saved = json.loads((backup / 'baseline.json').read_text())
assert manifest['git_commit'] == COMMIT and manifest['release'] == RELEASE
assert sha(stage / 'gps-tracker-api-dev') == manifest['api_sha256']
assert sha(stage / 'source.tar.gz') == manifest['source_sha256']
for name, digest in manifest['web_files'].items():
    assert sha(stage / 'web' / name) == digest
os.umask(0o077)

def envfile(path):
    return {k: v.strip().strip('"').strip("'") for k, v in
            (line.split('=', 1) for line in path.read_text().splitlines() if '=' in line and not line.startswith('#'))}

def run(args):
    subprocess.run(args, check=True)

def get(path, local=False):
    with urllib.request.urlopen(('http://127.0.0.1:3042' if local else 'https://gps.serial.kr') + path, timeout=20) as response:
        return response.read()

def wait_health(local=False, release=None):
    for _ in range(20):
        try:
            result = json.loads(get('/health', local))
            if result.get('ok') and result.get('db') and (not release or result.get('release') == release):
                return result
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('Health check failed')

validation_env = envfile(backup / 'validation.env')
assert urllib.parse.urlsplit(validation_env['DATABASE_URL']).path == '/gps_tracker_dev_prodreview_20261009_connection'
assert validation_env['BIND_ADDR'] == '127.0.0.1:3042' and validation_env['APP_ENV'] == 'test'
for key in ('OPENAI_API_KEY', 'KAKAO_REST_API_KEY', 'FCM_SERVICE_ACCOUNT_PATH', 'TOSS_SECRET_KEY', 'ONCE_API_TOKEN', 'ONCE_API_CLIENT_SECRET'):
    assert not validation_env.get(key), 'External credentials must not enter clone validation'

if MODE in ('validate', 'rollback-check'):
    # dotenv walks ancestors. Never run an isolated clone from the live .env directory.
    assert not any((path / '.env').exists() for path in [stage, *stage.parents])
    import socket
    with socket.socket() as sock:
        assert sock.connect_ex(('127.0.0.1', 3042)) != 0, 'Validation port is occupied'
    binary = stage / 'gps-tracker-api-dev' if MODE == 'validate' else backup / 'api.rollback-schema68'
    unit = 'gps-connection-clone-check'
    try:
        binary.chmod(0o755)
        run(['systemd-run', '--collect', '--unit=' + unit, '-p', 'User=mmm', '-p', 'Group=mmm',
             '-p', 'EnvironmentFile=' + str(backup / 'validation.env'), '-p', 'MemoryMax=500M',
             '-p', 'WorkingDirectory=' + str(stage), str(binary)])
        wait_health(True)
        if MODE == 'validate':
            for script in ('test_dev_api.py', 'test_dev_resilience.py', 'test_dev_speed.py', 'test_app_fcm_kc.py'):
                run(['python3', str(stage / script), str(backup / 'validation.env'), 'http://127.0.0.1:3042'])
        with psycopg2.connect(validation_env['DATABASE_URL']) as db:
            with db.cursor() as cursor:
                cursor.execute('SELECT max(version) FROM _sqlx_migrations WHERE success')
                assert cursor.fetchone()[0] == 68
        (backup / (MODE + '.json')).write_text(json.dumps({'release': RELEASE, 'api_sha256': sha(binary), 'schema': 68}))
        print('PASS', MODE, 'schema 68', flush=True)
    finally:
        subprocess.run(['systemctl', 'stop', unit], check=False)
    sys.exit(0)

assert json.loads((backup / 'validate.json').read_text())['api_sha256'] == manifest['api_sha256']
assert json.loads((backup / 'rollback-check.json').read_text())['api_sha256'] == sha(backup / 'api.rollback-schema68')
receipt = json.loads((backup / 'offsite-verified.json').read_text())
for name, digest in receipt['files'].items():
    assert sha(backup / name) == digest
assert sha(api) == saved['api_sha256'] and str(web.resolve()) == saved['web']
assert sha(env_path) == saved['env_sha256'] and sha(nginx) == saved['nginx_sha256']
env = envfile(env_path)
db = psycopg2.connect(env['DATABASE_URL'])
db.set_session(readonly=True, autocommit=True)
cursor = db.cursor()
cursor.execute("SELECT version,encode(checksum,'hex') FROM _sqlx_migrations WHERE success ORDER BY version")
applied = dict(cursor.fetchall())
with tarfile.open(stage / 'source.tar.gz') as source:
    embedded = {int(pathlib.PurePosixPath(member.name).name.split('_')[0]): hashlib.sha384(source.extractfile(member).read()).hexdigest()
                for member in source.getmembers() if member.isfile() and member.name.startswith('gps-tracker-api/migrations/') and member.name.endswith('.sql')}
assert set(embedded) - set(applied) == {68}
assert all(embedded[v] == checksum for v, checksum in applied.items())
kc = {path: hashlib.sha256(get(path)).hexdigest() for path in ['/diagnostic', '/diagnostic/device']}
target.mkdir()
shutil.copytree(stage / 'web', target / 'web')
for file in (web.resolve() / 'assets').iterdir():
    if file.is_file() and not (target / 'web/assets' / file.name).exists():
        shutil.copy2(file, target / 'web/assets' / file.name)
uploads = pathlib.Path(env.get('UPLOAD_DIR', '/home/mmm/uploads'))
assert uploads.is_absolute() and uploads.is_dir()
(target / 'web/uploads').symlink_to(uploads, target_is_directory=True)
shutil.copy2(stage / 'manifest.json', target / 'build-manifest.json')
shutil.copy2(stage / 'source.tar.gz', target / 'source.tar.gz')
(target / 'web/version.json').write_text(json.dumps(dict(manifest, target='production')))
for root, dirs, files in os.walk(target):
    pathlib.Path(root).chmod(0o755)
    for name in files:
        (pathlib.Path(root) / name).chmod(0o644)

# Add reminder preferences before restarting. No external workers/listeners in this mode.
run(['systemd-run', '--wait', '--pipe', '--collect', '--unit=gps-connection-migrate', '-p', 'User=mmm', '-p', 'Group=mmm',
     '-p', 'EnvironmentFile=' + str(env_path), '-p', 'WorkingDirectory=/home/mmm/projects/gps-tracker-api',
     '-E', 'GPS_MIGRATE_ONLY=1', str(stage / 'gps-tracker-api-dev')])
next_api = api.with_name('gps-tracker-api.next-connection')
next_web = web.with_name('dist-root.next-connection')
assert not next_web.exists() and not next_web.is_symlink()
try:
    shutil.copy2(stage / 'gps-tracker-api-dev', next_api)
    next_api.chmod(0o755)
    os.replace(next_api, api)
    run(['systemctl', 'restart', 'gps-tracker-api'])
    wait_health(release=RELEASE)
    next_web.symlink_to(target / 'web', target_is_directory=True)
    os.replace(next_web, web)
    assert json.loads(get('/version.json'))['git_commit'] == COMMIT
    for name, digest in manifest['web_files'].items():
        assert hashlib.sha256(get('/' + name)).hexdigest() == digest
    for path, digest in kc.items():
        assert hashlib.sha256(get(path)).hexdigest() == digest
    assert sha(env_path) == saved['env_sha256'] and sha(nginx) == saved['nginx_sha256']
    cursor.execute('SELECT max(version) FROM _sqlx_migrations WHERE success')
    assert cursor.fetchone()[0] == 68
    result = {'release': RELEASE, 'commit': COMMIT, 'api_sha256': sha(api), 'schema': 68,
              'kc_unchanged': True, 'configuration_unchanged': True, 'backup': str(backup)}
    (target / 'deployment.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
except Exception:
    shutil.copy2(backup / 'api.rollback-schema68', next_api)
    next_api.chmod(0o755)
    os.replace(next_api, api)
    if next_web.is_symlink():
        next_web.unlink()
    next_web.symlink_to(saved['web'], target_is_directory=True)
    os.replace(next_web, web)
    run(['systemctl', 'restart', 'gps-tracker-api'])
    wait_health()
    print('Rolled back runtime; schema 68 and notification receipts preserved.', flush=True)
    raise
