"""Shield batch API and exact nginx route addition; preserves SPA, env, schema and KC routes.

Run prepare, copy backup.tar.gz offsite and write offsite-verified.json with its
SHA-256, then apply. Deploy dev before prod. No DB records are written here.
"""
import hashlib
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

mode, environment, release = sys.argv[1:]
assert mode in ('prepare', 'apply') and environment in ('dev', 'prod')
assert re.fullmatch(r'dev-20260928-[0-9]{6}-[a-f0-9]{7}', release)
prod = environment == 'prod'
port = 3040 if prod else 3041
domain = 'gps.serial.kr' if prod else 'dev-gps.serial.kr'
service = 'gps-tracker-api' if prod else 'gps-tracker-api-dev'
base = pathlib.Path('/home/mmm/projects/gps-tracker-api' if prod else '/home/gps-dev/projects/gps-tracker-api')
api = base / 'bin' / ('gps-tracker-api' if prod else 'gps-tracker-api-dev')
env = base / ('.env' if prod else '.env.dev')
nginx = pathlib.Path('/etc/nginx/sites-available') / ('gps.serial.kr' if prod else 'dev-gps.serial.kr.conf')
stage = pathlib.Path('/home/mmm/gps-artifacts') / release
backup = pathlib.Path('/home/mmm/backups') / ('gps-shield-batch-' + environment + '-' + release)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = json.loads((stage / 'manifest.json').read_text())
assert manifest['release'] == release
assert manifest['git_commit'].startswith(release.rsplit('-', 1)[1])
assert sha(stage / 'gps-tracker-api-dev') == manifest['api_sha256']
assert sha(stage / 'source.tar.gz') == manifest['source_sha256']
os.umask(0o027)


def get(path, host=domain):
    with urllib.request.urlopen('https://' + host + path, timeout=15) as response:
        return response.read()


def schema():
    values = dict(line.split('=', 1) for line in env.read_text().splitlines()
                  if '=' in line and not line.startswith('#'))
    with psycopg2.connect(values['DATABASE_URL'].strip().strip('"').strip("'")) as db:
        db.set_session(readonly=True, autocommit=True)
        with db.cursor() as cursor:
            cursor.execute('SELECT max(version),count(*) FROM _sqlx_migrations')
            return list(cursor.fetchone())


def checked_status(path, expected):
    try:
        with urllib.request.urlopen('https://' + domain + path, timeout=15) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    assert status == expected, (path, status)


if mode == 'prepare':
    assert not backup.exists(), 'Backup already exists; inspect it before retrying.'
    baseline = json.loads(get('/health'))['release']
    assert baseline in (['dev-20260928-115217-dd57257'] if prod else ['dev-20260928-115217-dd57257','dev-20260928-122815-efb10f5'])
    if prod:
        assert json.loads(get('/health', 'dev-gps.serial.kr'))['release'] == release
    old = nginx.read_text()
    assert old.count('    location /diagnostic {') == 1
    assert old.count('    location = /arduino-shield {') == 1
    assert old.count('    location = /arduino-shield/data {') == 1
    has_route = '/ingest/shield' in old
    assert not has_route or not prod
    blocks = re.findall(r'    location = /ingest \{\n.*?\n    \}', old, re.S)
    assert len(blocks) == 2
    planned = old
    for block in ([] if has_route else blocks):
        planned = planned.replace(block, block + '\n\n' + block.replace('/ingest', '/ingest/shield').replace('64k;', '8k;'), 1)
    backup.mkdir(mode=0o700, parents=True)
    shutil.copy2(api, backup / 'api.previous')
    shutil.copy2(nginx, backup / 'nginx.previous')
    (backup / 'nginx.planned').write_text(planned)
    before = dict(api=sha(api), nginx=sha(nginx), env=sha(env), schema=schema(),
                  pages={p: hashlib.sha256(get(p)).hexdigest() for p in
                         ['/', '/version.json', '/diagnostic', '/diagnostic/device']})
    assert before['schema'][0] == 65
    (backup / 'before.json').write_text(json.dumps(before, indent=2))
    with tarfile.open(backup / 'backup.tar.gz', 'w:gz') as archive:
        for filename in ['api.previous', 'nginx.previous', 'before.json']:
            archive.add(backup / filename, arcname=filename)
    print(json.dumps({'backup': str(backup), 'sha256': sha(backup / 'backup.tar.gz')}))
    sys.exit(0)

assert json.loads((backup / 'offsite-verified.json').read_text())['sha256'] == sha(backup / 'backup.tar.gz')
before = json.loads((backup / 'before.json').read_text())
assert sha(api) == before['api'] and sha(nginx) == before['nginx'] and sha(env) == before['env']
assert schema() == before['schema']
next_api = api.with_name(api.name + '.next-shield')
stat = api.stat()
shutil.copy2(stage / 'gps-tracker-api-dev', next_api)
os.chown(next_api, stat.st_uid, stat.st_gid)
next_api.chmod(0o755)
try:
    os.replace(next_api, api)
    subprocess.run(['systemctl', 'restart', service], check=True)
    for attempt in range(20):
        try:
            with urllib.request.urlopen('http://127.0.0.1:' + str(port) + '/health', timeout=2) as response:
                health = json.load(response)
            if health['release'] == release and health['db']:
                break
        except (OSError, ValueError):
            pass
        time.sleep(.5)
    else:
        raise RuntimeError('API health failed')
    shutil.copyfile(backup / 'nginx.planned', nginx)
    subprocess.run(['nginx','-t'], check=True)
    subprocess.run(['systemctl','reload','nginx'], check=True)
    for attempt in range(20):
        page = get('/arduino-shield')
        if '아두이노 쉴드 수신 모니터' in page.decode():
            break
        time.sleep(.5)
    else:
        (backup / 'unexpected-page.html').write_bytes(page)
        raise RuntimeError('Public shield route did not become ready')
    data = json.loads(get('/arduino-shield/data'))
    assert data['device_uid'] == 'uno-shield-test' and len(data['items']) <= 100
    if prod:
        assert data['available'] and data['count_24h'] > 0 and data['items']
    assert all(not {'lat', 'lng', 'iccid', 'raw', 'owner_id'} & row.keys() for row in data['items'])
    checked_status('/arduino-shield/data?uid=esp-release-readonly-check', 400)
    assert schema() == before['schema'] and sha(env) == before['env'] and sha(nginx) == sha(backup / 'nginx.planned')
    for path, digest in before['pages'].items():
        assert hashlib.sha256(get(path)).hexdigest() == digest, path
    for scheme in ['http', 'https']:
        request = urllib.request.Request(scheme + '://' + domain + '/ingest',
            data=b'{"device_uid":{}}', headers={'Content-Type': 'application/json'})
        try:
            urllib.request.urlopen(request, timeout=15)
            raise AssertionError('Invalid ingest payload accepted')
        except urllib.error.HTTPError as error:
            assert error.code == 400 and json.loads(error.read())['error'].startswith('invalid payload:')
    for scheme in ['http','https']:
        request = urllib.request.Request(scheme+'://'+domain+'/ingest/shield',data=b'{}',headers={'Content-Type':'application/json'})
        try:
            urllib.request.urlopen(request,timeout=15)
            raise AssertionError('invalid shield payload accepted')
        except urllib.error.HTTPError as error:
            assert error.code == 400 and 'invalid shield v1 payload' in error.read().decode()
    result = dict(environment=environment, release=release, api_sha256=sha(api),
                  schema=before['schema'], kc_and_spa_pages_unchanged=True,
                  last_seen=data['last_seen_at'], records_24h=data['count_24h'])
    (backup / 'deployment.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
except Exception:
    shutil.copyfile(backup / 'nginx.previous', nginx)
    subprocess.run(['nginx','-t'],check=True)
    subprocess.run(['systemctl','reload','nginx'],check=True)
    shutil.copy2(backup / 'api.previous', next_api)
    os.chown(next_api, stat.st_uid, stat.st_gid)
    next_api.chmod(0o755)
    os.replace(next_api, api)
    subprocess.run(['systemctl', 'restart', service], check=True)
    raise
