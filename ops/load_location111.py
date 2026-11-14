"""Real HTTP concurrency + encrypted writes on the fixed synthetic internal network."""
import argparse
import base64
import concurrent.futures
import hashlib
import hmac
import json
import os
import statistics
import subprocess
import threading
import time
import urllib.error
import urllib.request

import psycopg

from benchmark_location111 import DB, JOB, NAME, NET, OUT, connect, info, run, save

API = 'gps-query111-api'
JWT = 'query111-synthetic-only-jwt-key'


def start():
    from admin_db_roles import run as roles
    with connect() as db:
        assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone() in ((110,), (111,))
        db.execute("UPDATE location_subject_policy SET enabled=true,reference='isolated-query111-policy',push_enabled=false WHERE singleton")
        exists = db.execute("SELECT 1 FROM pg_roles WHERE rolname='gps_runtime'").fetchone()
        host = info('container', DB)['NetworkSettings']['Networks'][NET]['IPAddress']
        if not exists:
            roles(f'postgres://postgres:query111-synthetic@{host}/{NAME}', True, JOB / 'test-runtime.json')
    credentials = json.loads((JOB / 'test-runtime.json').read_text())
    storage = JOB / 'load-storage'
    storage.mkdir(exist_ok=True)
    for name in ('uploads', 'private'):
        (storage / name).mkdir(exist_ok=True)
    run('docker', 'run', '-d', '--name', API, '--network', NET, '--cpus=2', '--memory=550m',
        '--user', f'{os.getuid()}:{os.getgid()}', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '-e', 'APP_ENV=test', '-e', 'BIND_ADDR=0.0.0.0:3043', '-e', 'GPS_DATABASE_MODE=runtime',
        '-e', f"DATABASE_URL=postgres://gps_runtime:{credentials['password']}@query-db/{NAME}",
        '-e', 'JWT_SECRET=' + JWT, '-e', 'SMS_DEV_MODE=1',
        '-e', 'GPS_LOCATION_ENCRYPTION=pilot', '-e', 'GPS_LOCATION_KEYRING_FILE=/keys.json',
        '-e', 'GPS_LOCATION_ACCESS_LOG=on', '-e', 'GPS_LOCATION_ACCESS_FLUSH_SECONDS=1',
        '-e', 'GPS_SUBJECT_PROVISION=on',
        '-e', 'UPLOAD_DIR=' + str(storage / 'uploads'), '-e', 'PRIVATE_UPLOAD_DIR=' + str(storage / 'private'),
        '-v', f'{storage}:{storage}', '-v', f'{JOB}/test-keys.json:/keys.json:ro',
        '-v', f'{OUT}/gps-tracker-api:/api:ro', 'gps-build:rust1.88-node22.22.2', '/api', stdout=subprocess.DEVNULL)
    for _ in range(60):
        try:
            status, body, _ = request('/gps-tracker/health')
            if status == 200 and json.loads(body)['db']:
                print('API READY: schema110/111 restricted runtime, encrypted, ledger enabled', flush=True)
                return
        except (OSError, ValueError, KeyError):
            pass
        if not info('container', API)['State']['Running']:
            raise RuntimeError('test API exited; inspect its private startup log')
        time.sleep(1)
    raise RuntimeError('test API readiness timeout')


def token(uid):
    def encoded(v):
        return base64.urlsafe_b64encode(json.dumps(v, separators=(',', ':')).encode()).rstrip(b'=')
    now = int(time.time())
    value = encoded({'alg': 'HS256', 'typ': 'JWT'}) + b'.' + encoded({'sub': str(uid), 'exp': now + 7200, 'iat': now, 'typ': 'access'})
    return (value + b'.' + base64.urlsafe_b64encode(hmac.new(JWT.encode(), value, hashlib.sha256).digest()).rstrip(b'=')).decode()


def base():
    container = info('container', API)
    assert not container['HostConfig']['PortBindings'] and info('network', NET)['Internal']
    return 'http://' + container['NetworkSettings']['Networks'][NET]['IPAddress'] + ':3043'


BASE = None


def request(path, auth=None):
    global BASE
    if BASE is None:
        BASE = base()
    req = urllib.request.Request(BASE + path, headers={'Authorization': 'Bearer ' + auth} if auth else {})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            code, body = response.status, response.read()
    except urllib.error.HTTPError as error:
        code, body = error.code, error.read()
    return code, body, time.monotonic() - started


def stats(values):
    values = sorted(values)
    if not values:
        return {'count': 0, 'p50_s': None, 'p95_s': None, 'max_s': None}
    return {'count': len(values), 'p50_s': statistics.median(values),
            'p95_s': values[min(len(values) - 1, int(len(values) * .95))], 'max_s': max(values)}


def load(workers, iterations):
    binary_hash = subprocess.check_output(['docker', 'exec', API, 'sha256sum', '/proc/1/exe']).decode().split()[0]
    assert binary_hash == hashlib.sha256((OUT / 'gps-tracker-api').read_bytes()).hexdigest(), 'restart the API after rebuilding'
    fixture = json.loads((OUT / 'fixture.json').read_text())
    did, uid = fixture['device_id'], fixture['user_id']
    auth = token(uid)
    path = f'/gps-tracker/api/v1/devices/{did}/locations'
    since = 'since=2026-10-10T00:00:00Z&until=2026-10-11T00:00:00Z'
    routes = [('latest', path + '/latest'), ('day_page', path + '/page?' + since + '&limit=500'),
              ('day_aggregate', path + '/aggregated?' + since + '&bucket=5m'),
              ('day_history', path + '?' + since + '&limit=1000'),
              ('month_page', path + '/page?since=2026-10-01T00:00:00Z&until=2026-11-01T00:00:00Z&limit=500')]
    for _, route in routes:
        code, body, _ = request(route, auth)
        assert code == 200, (route, code, body[:200])
        assert request(route, token(uid + 999999))[0] in (401, 404)
    stop = threading.Event()
    results, errors, health, writes = [], [], [], []
    with connect() as db:
        settings = dict(db.execute("SELECT name,setting FROM pg_settings WHERE name IN ('max_connections','superuser_reserved_connections')").fetchall())
        assert int(settings['max_connections']) >= 32, 'need main10 + privacy16 + writer1 + reserved3 + probes'
        writer = db.execute("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,%s,'') RETURNING id", (uid, 'query-load-' + str(time.time_ns()))).fetchone()[0]

    def background():
        credentials = json.loads((JOB / 'test-runtime.json').read_text())
        host = info('container', DB)['NetworkSettings']['Networks'][NET]['IPAddress']
        with psycopg.connect(f"postgres://gps_runtime:{credentials['password']}@{host}/{NAME}", autocommit=True) as db:
            db.execute("SELECT set_config('gps.storage_keys',%s,false)", ((JOB / 'test-keys.json').read_text(),))
            db.execute("SET statement_timeout='10s'; SET jit=off")
            while not stop.is_set():
                try:
                    started = time.monotonic()
                    db.execute("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES(%s,%s,clock_timestamp(),'load',true,37.1,127.1)", (writer, uid))
                    writes.append(time.monotonic() - started)
                    code, _, elapsed = request('/gps-tracker/health')
                    health.append(elapsed)
                    if code != 200:
                        errors.append({'background_health': code})
                except Exception as e:
                    errors.append({'background': type(e).__name__})
                stop.wait(.2)

    barrier = threading.Barrier(workers)

    def worker(index):
        barrier.wait()
        for i in range(iterations):
            name, route = routes[(index + i) % len(routes)]
            try:
                code, body, elapsed = request(route, auth)
                if code != 200:
                    errors.append({'route': name, 'status': code})
                else:
                    assert body not in (b'null', b'[]')
                    json.loads(body)
                    results.append({'route': name, 'seconds': elapsed, 'bytes': len(body)})
            except Exception as e:
                errors.append({'route': name, 'error': type(e).__name__})

    def background_checked():
        try:
            background()
        except Exception as error:
            errors.append({'background_setup': type(error).__name__})

    thread = threading.Thread(target=background_checked)
    thread.start()
    started = time.monotonic()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(worker, range(workers)))
    finally:
        stop.set()
        thread.join()
    with connect() as db:
        physical = db.execute('SELECT count(*),count(*) FILTER(WHERE lat IS NOT NULL OR lng IS NOT NULL),bool_and(query_bounds_ready) FROM location_records WHERE device_id=%s', (writer,)).fetchone()
        if physical != (len(writes), 0, True):
            errors.append({'encrypted_write_verification': list(physical), 'recorded_writes': len(writes)})
    report = {'api_sha256': binary_hash, 'workers': workers, 'iterations': iterations, 'duration_s': time.monotonic() - started,
              'requests': len(results), 'errors': errors, 'http': {name: stats([r['seconds'] for r in results if r['route'] == name]) for name, _ in routes},
              'health': stats(health), 'encrypted_writes': stats(writes), 'raw': results,
              'db_connection_settings': settings, 'api_pool_limits': {'queries': 10, 'privacy_leases': 16},
              'storage': 'disk-backed ext4/NVMe synthetic DB; DB 2 CPU/1500MiB, API 2 CPU/550MiB',
              'external_delivery': False, 'production_modified': False}
    save(f'load111-{workers}.json', report)
    assert not errors, errors
    assert len(results) == workers * iterations and health and writes
    assert report['health']['p95_s'] < 2 and report['encrypted_writes']['p95_s'] < 2, 'interactive health/write budget exceeded'
    print('LOAD PASS', workers, len(results), 'health p95', round(report['health']['p95_s'], 3), 'write p95', round(report['encrypted_writes']['p95_s'], 3), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['start', 'load'])
    p.add_argument('--workers', type=int, default=8)
    p.add_argument('--iterations', type=int, default=10)
    args = p.parse_args()
    if args.action == 'start':
        start()
    else:
        assert 1 <= args.workers <= 16 and 5 <= args.iterations <= 50
        load(args.workers, args.iterations)
