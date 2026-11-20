"""GPS history hotfix. No schema/config/firmware or payment changes.

prepare -> prepare_prod_review.py -> validate -> seal -> offsite copy -> promote.
Pinned to the inspected production API/web; all regression writes use a clone.
"""
import base64
import hashlib
import hmac
import json
import os
import pathlib
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
assert mode in ('prepare', 'validate', 'seal', 'promote')
assert re.fullmatch(r'dev-20261007-\d{6}-21adc14', release)
os.umask(0o027)
stage = pathlib.Path('/home/mmm/gps-artifacts') / release
backup = pathlib.Path('/home/mmm/backups') / ('gps-history-' + release)
target = pathlib.Path('/home/mmm/releases') / release.replace('dev-', 'prod-', 1)
api = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
web = pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
env_path = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
nginx = pathlib.Path('/etc/nginx/sites-available/gps.serial.kr')
expected_api = '81214c4f4c49ee361a92271f913271ccc9bc633b7d0e41e51807df945cae79d9'
expected_web = pathlib.Path('/home/mmm/releases/gps-web-20261006-221245-3cb7de9/web')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = json.loads((stage / 'manifest.json').read_text())
assert manifest['release'] == release and manifest['git_commit'] == '21adc14482b5ac3ab71b8f66760aa55b8954b459'
assert sha(stage / 'gps-tracker-api-dev') == manifest['api_sha256']
assert sha(stage / 'source.tar.gz') == manifest['source_sha256']
for name, digest in manifest['web_files'].items():
    p = (stage / 'web' / name).resolve()
    assert p.is_relative_to(stage / 'web') and sha(p) == digest

def envfile(path):
    return {k: v.strip().strip('"').strip("'") for k, v in
            (l.split('=', 1) for l in path.read_text().splitlines() if '=' in l and not l.startswith('#'))}

def get(path, token=None):
    req = urllib.request.Request('https://gps.serial.kr' + path,
        headers={'Authorization': 'Bearer ' + token} if token else {})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()

env = envfile(env_path)
db = psycopg2.connect(env['DATABASE_URL'])
db.set_session(readonly=True, autocommit=True)
c = db.cursor()
c.execute("SET statement_timeout='20s'")

def scalar(sql):
    c.execute(sql)
    return c.fetchone()[0]

# Refuse a binary with any new, missing or changed embedded SQL migration.
c.execute('SELECT version,encode(checksum,\'hex\') FROM _sqlx_migrations WHERE success ORDER BY version')
migrations = dict(c.fetchall())
with tarfile.open(stage / 'source.tar.gz') as source:
    embedded = {int(pathlib.PurePosixPath(m.name).name.split('_')[0]): hashlib.sha384(source.extractfile(m).read()).hexdigest()
        for m in source.getmembers() if m.isfile() and re.fullmatch(r'gps-tracker-api/migrations/\d+_.+\.sql', m.name)}
assert embedded == migrations, 'Embedded migrations differ from production'

controls = "SELECT md5(string_agg(row_to_json(d)::text,'' ORDER BY id)) FROM (SELECT id,device_uid,owner_id,iccid,beep_pending,reset_pending,post_interval_pending FROM devices) d"

def baseline():
    return {'api': sha(api), 'web': str(web.resolve()), 'env': sha(env_path), 'nginx': sha(nginx),
        'controls': scalar(controls), 'migrations': migrations,
        'kc': {p: hashlib.sha256(get(p)).hexdigest() for p in ['/diagnostic', '/diagnostic/device']}}

def run(args):
    subprocess.run(args, check=True)

if mode == 'prepare':
    assert sha(api) == expected_api and web.resolve() == expected_web
    backup.mkdir(mode=0o700)
    shutil.copy2(api, backup / 'api.previous')
    run(['tar', '-czf', str(backup / 'web.previous.tar.gz'), '-C', str(expected_web), '--exclude=./uploads', '.'])
    (backup / 'baseline.json').write_text(json.dumps(baseline(), indent=2))
    (backup / 'backup-hashes.json').write_text(json.dumps({p.name: sha(p) for p in backup.iterdir() if p.is_file()}, indent=2))
    print('Prepared private rollback backup:', backup)

elif mode == 'validate':
    validation = backup / 'validation.env'
    v = envfile(validation)
    from urllib.parse import urlparse
    assert urlparse(v['DATABASE_URL']).path.startswith('/gps_tracker_dev')
    assert v['BIND_ADDR'] == '127.0.0.1:3042' and v['APP_ENV'] == 'test'
    for key in ('FCM_SERVICE_ACCOUNT_PATH', 'TOSS_SECRET_KEY', 'TOSS_WEBHOOK_SECRET', 'ONCE_API_TOKEN', 'ONCE_API_CLIENT_SECRET'):
        assert not v.get(key), key + ' must be empty in validation'
    import socket
    with socket.socket() as sock:
        assert sock.connect_ex(('127.0.0.1', 3042)) != 0, 'Validation port occupied'
    unit = 'gps-history-clone-check'
    try:
        run(['systemd-run', '--collect', '--unit=' + unit, '-p', 'User=mmm', '-p', 'Group=mmm',
            '-p', 'WorkingDirectory=/home/mmm/projects/gps-tracker-api', '-p', 'EnvironmentFile=' + str(validation),
            '-p', 'MemoryMax=500M', '-p', 'NoNewPrivileges=true', str(stage / 'gps-tracker-api-dev')])
        run(['curl', '--silent', '--fail', '--retry', '5', '--retry-delay', '1', '--retry-connrefused', 'http://127.0.0.1:3042/health'])
        for script in ('test_dev_api.py', 'test_dev_resilience.py', 'test_dev_speed.py', 'test_app_fcm_kc.py'):
            run(['python3', str(stage / script), str(validation), 'http://127.0.0.1:3042'])
        (backup / 'clone-check-passed.json').write_text(json.dumps({'release': release, 'api_sha256': sha(stage / 'gps-tracker-api-dev')}))
        print('PASS clone regression suites, including history/KC/auth/ingest; no production writes')
    finally:
        subprocess.run(['systemctl', 'stop', unit], check=False)

elif mode == 'seal':
    assert (backup / 'clone-check-passed.json').exists()
    hashes = {p.name: sha(p) for p in backup.iterdir() if p.is_file()
        and p.name not in ('backup-hashes.json', 'offsite-verified.json')}
    (backup / 'backup-hashes.json').write_text(json.dumps(hashes, indent=2))
    print('Sealed', len(hashes), 'private rollback and validated database backup files')

else:
    saved = json.loads((backup / 'baseline.json').read_text())
    assert baseline() == saved | {'migrations': migrations}
    assert sha(api) == expected_api and web.resolve() == expected_web
    assert json.loads((backup / 'clone-check-passed.json').read_text())['api_sha256'] == manifest['api_sha256']
    assert json.loads((backup / 'offsite-verified.json').read_text()) == json.loads((backup / 'backup-hashes.json').read_text())
    for name, digest in json.loads((backup / 'backup-hashes.json').read_text()).items():
        assert sha(backup / name) == digest
    target.mkdir()
    shutil.copytree(stage / 'web', target / 'web')
    for p in (expected_web / 'assets').iterdir():
        if p.is_file() and not (target / 'web/assets' / p.name).exists():
            shutil.copy2(p, target / 'web/assets' / p.name)
    upload = pathlib.Path(env.get('UPLOAD_DIR', '/home/mmm/uploads'))
    assert upload.is_absolute() and upload.is_dir()
    (target / 'web/uploads').symlink_to(upload, target_is_directory=True)
    shutil.copy2(stage / 'manifest.json', target / 'build-manifest.json')
    shutil.copy2(stage / 'source.tar.gz', target / 'source.tar.gz')
    (target / 'web/version.json').write_text(json.dumps(dict(manifest, target='production'), indent=2))
    for root, dirs, files in os.walk(target):
        pathlib.Path(root).chmod(0o755)
        for name in files:
            (pathlib.Path(root) / name).chmod(0o644)
    next_api = api.with_name('gps-tracker-api.next-history')
    next_web = web.with_name('dist-root.next-history')
    assert not next_web.exists() and not next_web.is_symlink()
    shutil.copy2(stage / 'gps-tracker-api-dev', next_api)
    next_api.chmod(0o755)
    try:
        os.replace(next_api, api)
        run(['systemctl', 'restart', 'gps-tracker-api'])
        for _ in range(15):
            try:
                health = json.loads(get('/health'))
                if health.get('release') == release and health.get('environment') == 'production':
                    break
            except Exception:
                pass
            time.sleep(1)
        else:
            raise RuntimeError('New API health failed')
        next_web.symlink_to(target / 'web', target_is_directory=True)
        os.replace(next_web, web)
        assert json.loads(get('/version.json'))['git_commit'] == manifest['git_commit']
        for name, digest in manifest['web_files'].items():
            assert hashlib.sha256(get('/' + name)).hexdigest() == digest, name
        for path, digest in saved['kc'].items():
            assert hashlib.sha256(get(path)).hexdigest() == digest
        assert sha(env_path) == saved['env'] and sha(nginx) == saved['nginx'] and scalar(controls) == saved['controls']
        for scheme in ('http', 'https'):
            req = urllib.request.Request(scheme + '://gps.serial.kr/ingest', data=b'{"device_uid":{}}', headers={'Content-Type': 'application/json'})
            try:
                urllib.request.urlopen(req, timeout=15)
                raise AssertionError('Invalid ingest accepted')
            except urllib.error.HTTPError as e:
                assert e.code == 400 and json.loads(e.read())['error'].startswith('invalid payload:')
        assert 'error' not in json.loads(get('/diagnostic/device/data?uid=esp-release-readonly-check'))
        c.execute("SELECT id,owner_id FROM devices WHERE device_uid LIKE '%520211'")
        devices = c.fetchall()
        assert devices
        results = []
        for did, uid in devices:
            enc = lambda o: base64.urlsafe_b64encode(json.dumps(o, separators=(',', ':')).encode()).rstrip(b'=')
            msg = enc({'alg':'HS256','typ':'JWT'}) + b'.' + enc({'sub':str(uid),'iat':int(time.time()),'exp':int(time.time())+300,'typ':'access'})
            token = (msg + b'.' + base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(), msg, hashlib.sha256).digest()).rstrip(b'=')).decode()
            for endpoint in ('active-dates', 'stats/daily?limit=365', 'locations/aggregated?bucket=5m&since=2026-10-01T00:00:00%2B09:00&until=2026-10-08T00:00:00%2B09:00'):
                rows = json.loads(get(f'/api/v1/devices/{did}/' + endpoint, token))
                assert isinstance(rows, list) and rows
                results.append({'device_id': did, 'endpoint': endpoint, 'rows': len(rows), 'status': 200})
        result = {'release': release, 'commit': manifest['git_commit'], 'device_checks': results,
            'kc_unchanged': True, 'configuration_unchanged': True, 'schema_unchanged': True, 'backup': str(backup)}
        (target / 'deployment.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result), flush=True)
    except Exception:
        rollback = api.with_name('gps-tracker-api.rollback-history')
        shutil.copy2(backup / 'api.previous', rollback)
        rollback.chmod(0o755)
        os.replace(rollback, api)
        if next_web.is_symlink():
            next_web.unlink()
        next_web.symlink_to(expected_web, target_is_directory=True)
        os.replace(next_web, web)
        run(['systemctl', 'restart', 'gps-tracker-api'])
        print('Rolled back API/web; database and configuration were not changed.', flush=True)
        raise
db.close()
