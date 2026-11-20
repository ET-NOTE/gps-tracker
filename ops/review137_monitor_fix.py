"""Apply the method-rejection compatibility fix on already deployed schema114.

No schema, environment, web bundle, firewall, monitor or policy change. A failed health
or 405 probe restores only the previous binary on the same schema.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.error
import urllib.request
import psycopg2

STAGE = Path('/home/mmm/gps-artifacts/review137-20261116-r1')
API = Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
ENV = Path('/home/mmm/projects/gps-tracker-api/.env')
BACKUP = Path('/home/mmm/backups/review137-20261116-r1/api.before-monitor-fix')


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(*args):
    return subprocess.check_output(args, text=True)


def check_health(release):
    for _ in range(20):
        try:
            with urllib.request.urlopen('http://127.0.0.1:3040/gps-tracker/health', timeout=4) as r:
                h = json.load(r)
                if h['ok'] and h['release'] == release:
                    return h
        except OSError:
            pass
        time.sleep(1)
    raise RuntimeError('health release mismatch')


def probe(url, method='GET', data=None):
    req = urllib.request.Request(url, method=method, data=data, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.headers.get('Allow')
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get('Allow')


assert os.geteuid() == 0
m = json.loads((STAGE / 'monitor-fix-manifest.json').read_text())
assert m['release'] == 'review137-20261116-r3' and m['tests_passed'] == 98
assert sha(STAGE / 'gps-tracker-api-r3') == m['api_sha256']
assert sha(API) == 'c6475670005ce79718d452ce882165f48a9e549249b97aad010f9247a0747cf8'
assert sha(ENV) == 'fab21aeaaef7a00f1283530e1136690c28d416d5d4d62b9968d4a6a6cdb3df55'
assert str(Path('/home/mmm/gps-tracker-web/dist-root').resolve()) == '/home/mmm/releases/review137-20261116-r2/web'
check_health('runtime136-20261116-r1')
config = {k: v.strip().strip('"').strip("'") for k, v in
          (line.split('=', 1) for line in ENV.read_text().splitlines()
           if '=' in line and not line.lstrip().startswith('#'))}
with psycopg2.connect(config['DATABASE_URL']) as db:
    db.set_session(readonly=True)
    with db.cursor() as q:
        q.execute('SELECT max(version) FROM _sqlx_migrations WHERE success')
        assert q.fetchone() == (114,)
assert not BACKUP.exists()
shutil.copy2(API, BACKUP)
next_api = API.with_name('gps-tracker-api.review137-r3')
assert not next_api.exists()
shutil.copy2(STAGE / 'gps-tracker-api-r3', next_api)
shutil.chown(next_api, user=API.stat().st_uid, group=API.stat().st_gid)
next_api.chmod(0o755)
started = time.time()
try:
    os.replace(next_api, API)
    run('systemctl', 'restart', 'gps-tracker-api')
    h = check_health(m['release'])
    checks = []
    for origin in ['http://gps.serial.kr', 'https://gps.serial.kr']:
        for method in ['GET', 'HEAD']:
            status, allowed = probe(origin + '/ingest', method)
            assert status == 405 and allowed == 'POST', (method, status, allowed)
            checks.append({'url': origin + '/ingest', 'method': method, 'status': status, 'allow': allowed})
    status, _ = probe('https://gps.serial.kr/ingest', 'POST', b'{')
    assert status == 400, status
    checks.append({'url': 'https://gps.serial.kr/ingest', 'method': 'POST malformed JSON', 'status': status})
except Exception:
    shutil.copy2(BACKUP, next_api)
    os.replace(next_api, API)
    run('systemctl', 'restart', 'gps-tracker-api')
    check_health('runtime136-20261116-r1')
    raise
report = {'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'passed': True, 'health': h,
          'api_sha256': sha(API), 'elapsed_seconds': round(time.time() - started, 3),
          'checks': checks, 'schema_changed': False, 'configuration_changed': False,
          'monitor_configuration_changed': False, 'user_data_mutated_by_probes': False}
version_path = Path('/home/mmm/releases/review137-20261116-r2/web/version.json')
version = json.loads(version_path.read_text())
version['api_release'] = m['release']
version_path.write_text(json.dumps(version))
(STAGE / 'monitor-fix-deployment.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report))
