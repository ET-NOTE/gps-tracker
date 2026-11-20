"""Real HTTP disconnect/429/DB-deadline checks, synthetic internal Docker only."""
import base64
import concurrent.futures
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
from urllib.parse import quote

import psycopg2

JOB = Path('/home/etcom-hub/build/gps-provision22-20261111query114')
TAG = '20261111query114'
NET, DB, API = ['gps-provision22-' + x + '-' + TAG for x in ('test', 'db', 'api')]
PROXY = 'gps-query114-proxy'
OUT = JOB / 'out'
JWT = 'closure-test-only-jwt-key-32-characters'
REPORT = {'production_modified': False, 'schema': 112, 'checks': []}


def info(kind, name):
    return json.loads(subprocess.check_output(['docker', kind, 'inspect', name]))[0]


def ip(name):
    assert info('network', NET)['Internal']
    item = info('container', name)
    assert not item['HostConfig']['PortBindings']
    return item['NetworkSettings']['Networks'][NET]['IPAddress']


def connect():
    db = psycopg2.connect(host=ip(DB), user='postgres', password='closure-test-only', dbname='gps_closure_test')
    db.autocommit = True
    return db


def rows(sql, params=()):
    with connect() as db, db.cursor() as cur:
        cur.execute(sql, params or None)
        return cur.fetchall() if cur.description else []


def save(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def passed(name, **details):
    REPORT['checks'].append({'name': name, **details})
    save('query114-tests.json', REPORT)
    print('PASS', name, details, flush=True)


def token(uid):
    def enc(value):
        return base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).rstrip(b'=')
    now = int(time.time())
    msg = enc({'alg': 'HS256', 'typ': 'JWT'}) + b'.' + enc({'sub': str(uid), 'iat': now, 'exp': now + 7200, 'typ': 'access'})
    return (msg + b'.' + base64.urlsafe_b64encode(hmac.new(JWT.encode(), msg, hashlib.sha256).digest()).rstrip(b'=')).decode()


def connection(proxy=False, timeout=35):
    if proxy:
        # Test-only CA trusted explicitly; no production certificate validation bypass.
        context = ssl.create_default_context(cafile=str(JOB / 'proxy/cert.pem'))
        return http.client.HTTPSConnection(ip(PROXY), 8443, context=context, timeout=timeout)
    return http.client.HTTPConnection(ip(API), 3043, timeout=timeout)


def request(path, uid=None, proxy=False):
    conn = connection(proxy)
    start = time.monotonic()
    conn.request('GET', path, headers={'Authorization': 'Bearer ' + token(uid)} if uid else {})
    response = conn.getresponse()
    result = response.status, response.read(), dict(response.getheaders()), time.monotonic() - start
    conn.close()
    return result


def paths(did):
    root = f'/gps-tracker/api/v1/devices/{did}/locations'
    interval = 'since=2026-10-01T00:00:00Z&until=2026-11-01T00:00:00Z'
    return [root + '?' + interval + '&limit=20&grouped=true',
            root + '/page?' + interval + '&limit=20',
            root + '/aggregated?' + interval + '&bucket=1h']


def start(binary):
    subprocess.run(['bash', str(JOB / 'dev22.sh'), 'stop'], check=True, stdout=subprocess.DEVNULL)
    shutil.copy2(OUT / binary, OUT / 'gps-tracker-api')
    secret = json.loads((JOB / 'test-runtime.json').read_text())
    env = os.environ.copy()
    env.update(RUNTIME_DSN='postgres://gps_runtime:' + quote(secret['password']) + '@closure-db/gps_closure_test',
               STORAGE='pilot', LEDGER='on')
    subprocess.run(['bash', str(JOB / 'dev22.sh'), 'api'], env=env, check=True)


def prepare():
    assert rows('SELECT max(version) FROM _sqlx_migrations') == [(112,)]
    subprocess.run(['bash', str(JOB / 'dev22.sh'), 'stop'], check=True)
    sys.path.insert(0, str(JOB / 'src/ops'))
    from admin_db_roles import run
    run('postgres://postgres:closure-test-only@' + ip(DB) + '/gps_closure_test', True, JOB / 'test-runtime.json')
    ring = {'active': 'query114', 'keys': {'query114': 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE='}}
    with (JOB / 'test-keys.json').open('x') as file:
        os.chmod(file.name, 0o600)
        json.dump(ring, file)
    with connect() as db, db.cursor() as cur:
        cur.execute("SELECT set_config('gps.storage_keys',%s,false)", (json.dumps(ring),))
        cur.execute('UPDATE location_storage_policy SET enabled=true,activated_at=now()')
        cur.execute("INSERT INTO users(phone,email,password_hash) VALUES('query114-a','query114-a@example.invalid',''),('query114-b','query114-b@example.invalid','') RETURNING id")
        uid, other = [r[0] for r in cur.fetchall()]
        cur.execute("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,'query114-synthetic','') RETURNING id", (uid,))
        did = cur.fetchone()[0]
        cur.execute("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) SELECT %s,%s,'2026-10-01'::timestamptz+i*interval '1 hour','l80',true,35+i*.00001,127 FROM generate_series(0,743) i", (did, uid))
    save('fixture.json', {'user_id': uid, 'other_id': other, 'device_id': did})
    shutil.copy2(OUT / 'gps-tracker-api', OUT / 'candidate114')
    start('baseline113')
    baseline = []
    for path in paths(did):
        status, body, _, _ = request(path, uid)
        assert status == 200, (status, body[:100])
        baseline.append(json.loads(body))
    save('baseline113-responses.json', baseline)
    start('candidate114')
    # TLS reverse proxy exercises the browser-facing cancellation boundary.
    proxy = JOB / 'proxy'
    proxy.mkdir()
    subnet = info('network', NET)['IPAM']['Config'][0]['Subnet']
    proxy_ip = subnet.rsplit('.', 1)[0] + '.10'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
                    '-subj', '/CN=query114.invalid', '-addext', 'subjectAltName=IP:' + proxy_ip,
                    '-keyout', str(proxy / 'key.pem'), '-out', str(proxy / 'cert.pem')], check=True, capture_output=True)
    os.chmod(proxy / 'key.pem', 0o600)
    (proxy / 'default.conf').write_text('server { listen 8443 ssl; ssl_certificate /test/cert.pem; ssl_certificate_key /test/key.pem;'
        'location / { proxy_pass http://' + API + ':3043; proxy_ignore_client_abort off; proxy_read_timeout 35s; } }')
    subprocess.run(['docker', 'run', '-d', '--name', PROXY, '--network', NET, '--ip', proxy_ip,
                    '--memory=100m', '-v', str(proxy) + ':/test:ro', '-v', str(proxy / 'default.conf') + ':/etc/nginx/conf.d/default.conf:ro',
                    'nginx:stable-alpine'], check=True, stdout=subprocess.DEVNULL)
    for _ in range(30):
        try:
            if request('/gps-tracker/health', proxy=True)[0] == 200:
                break
        except OSError:
            time.sleep(.2)
    else:
        raise AssertionError('TLS proxy readiness')
    print('Prepared restricted encrypted runtime, synthetic data, trusted test TLS proxy', flush=True)


def active():
    return rows("SELECT pid,state,wait_event_type FROM pg_stat_activity WHERE application_name LIKE 'gps-read-%'")


def until(check, timeout=5):
    started = time.monotonic()
    while time.monotonic() - started < timeout:
        if check():
            return time.monotonic() - started
        time.sleep(.025)
    raise AssertionError('condition deadline exceeded')


def lock_locations():
    db = connect()
    db.autocommit = False
    with db.cursor() as cur:
        cur.execute('LOCK TABLE location_records IN ACCESS EXCLUSIVE MODE')
    return db


def open_read(path, uid, proxy=False):
    conn = connection(proxy)
    conn.request('GET', path, headers={'Authorization': 'Bearer ' + token(uid)})
    return conn


def disconnect(conn):
    conn.sock.shutdown(socket.SHUT_RDWR)
    conn.close()


def test():
    data = json.loads((OUT / 'fixture.json').read_text())
    uid, other, did = (data[k] for k in ('user_id', 'other_id', 'device_id'))
    routes = paths(did)
    baseline = json.loads((OUT / 'baseline113-responses.json').read_text())
    assert rows("SELECT rolsuper,pg_has_role('gps_runtime','pg_signal_backend','MEMBER') FROM pg_roles WHERE rolname='gps_runtime'") == [(False, False)]
    for path, expected in zip(routes, baseline):
        status, body, _, _ = request(path, uid, True)
        assert status == 200 and json.loads(body) == expected, (status, body[:200])
        assert request(path, other)[0] == 404
        assert request(path)[0] == 401
    passed('all three encrypted response shapes match113; other-account/auth rejection unchanged')
    for proxy in (False, True):
        for path in routes:
            completed_before = rows("SELECT count(*) FROM location_access_events WHERE outcome='response_ready'")[0][0]
            lock = lock_locations()
            try:
                first, second = open_read(path, uid, proxy), open_read(path, uid, proxy)
                until(lambda: len(active()) == 2 and all(r[2] == 'Lock' for r in active()))
                status, body, headers, _ = request(path, uid, proxy)
                assert status == 429 and json.loads(body)['code'] == 'location_read_busy'
                assert headers.get('retry-after', headers.get('Retry-After')) == '2'
                assert request('/gps-tracker/health', proxy=proxy)[0] == 200
                disconnect(first)
                elapsed = until(lambda: len(active()) == 1)
                replacement = open_read(path, uid, proxy)
                until(lambda: len(active()) == 2)
                disconnect(second)
                disconnect(replacement)
                until(lambda: not active())
                assert rows("SELECT count(*) FROM location_access_events WHERE outcome='response_ready'")[0][0] == completed_before
            finally:
                lock.rollback()
                lock.close()
            assert request(path, uid, proxy)[0] == 200
            passed('429, disconnect cancels DB, slot reuse, recovery', proxy_tls=proxy, route=path.split('?')[0], cancel_seconds=elapsed)
    # A connected client whose SQL is blocked receives a bounded, non-retryable
    # response; the HTTP 30s timeout cannot leave an unbounded SQL query behind.
    lock = lock_locations()
    try:
        status, body, _, elapsed = request(routes[1], uid, True)
        assert status == 408 and 19 <= elapsed < 27, (status, elapsed, body[:150])
        until(lambda: not active())
    finally:
        lock.rollback()
        lock.close()
    passed('DB 20 second deadline returns408 and releases connection', seconds=elapsed)
    # Repeated cancellation mixed with successful reads catches PID/connection
    # reuse races; completed query sessions must not retain local settings.
    for _ in range(10):
        lock = lock_locations()
        try:
            pending = open_read(routes[1], uid, True)
            until(lambda: len(active()) == 1)
            disconnect(pending)
            until(lambda: not active())
        finally:
            lock.rollback()
            lock.close()
        assert request(routes[1], uid, True)[0] == 200
    assert not active()
    assert rows("SELECT count(*) FROM pg_stat_activity WHERE usename='gps_runtime' AND state LIKE 'idle in transaction%'") == [(0,)]
    passed('10 cancel/success cycles, no stale cancel or idle transaction')
    REPORT['passed'] = True
    save('query114-tests.json', REPORT)


def extra():
    data = json.loads((OUT / 'fixture.json').read_text())
    uid, did = data['user_id'], data['device_id']
    route = paths(did)[1]
    # Exercise the actual web retry module against real429 responses. No fake
    # fetch/timer; all eight callers must recover and match the prior response.
    private = JOB / 'retry-private'
    private.mkdir(exist_ok=True)
    with (private / 'request.json').open('w') as file:
        os.chmod(file.name, 0o600)
        json.dump({'url': 'http://' + API + ':3043' + route, 'token': token(uid),
                   'expected': json.loads((OUT / 'baseline113-responses.json').read_text())[1]}, file)
    lock = lock_locations()
    first, second = open_read(route, uid), open_read(route, uid)
    until(lambda: len(active()) == 2)
    def release():
        disconnect(first)
        disconnect(second)
        lock.rollback()
        lock.close()
    timer = threading.Timer(1.5, release)
    timer.start()
    try:
        result = subprocess.run(['docker', 'run', '--rm', '--network', NET, '--memory=150m',
            '--user', str(os.getuid()) + ':' + str(os.getgid()),
            '-v', str(JOB / 'src') + ':/work:ro', '-v', str(private) + ':/test:ro',
            'gps-build:rust1.88-node22.22.2', 'node', '/work/ops/test_query114_retry.mjs'],
            check=True, capture_output=True, text=True, timeout=30)
        save('query114-real-retry.json', json.loads(result.stdout))
        print('PASS eight real web retries with identical payloads', flush=True)
    finally:
        timer.join()
        (private / 'request.json').unlink()
    # Pause continues to deny all protected shapes; it cannot be retried into a
    # response or populated from a cached previous account's data.
    rows('INSERT INTO privacy_processing_controls(user_id,use_paused) VALUES(%s,true) ON CONFLICT(user_id) DO UPDATE SET use_paused=true', (uid,))
    codes = [request(path, uid)[0] for path in paths(did)]
    assert all(code in (403, 423) for code in codes), codes
    assert not active()
    rows('UPDATE privacy_processing_controls SET use_paused=false WHERE user_id=%s', (uid,))
    assert request(route, uid)[0] == 200
    save('query114-paused.json', {'passed': True, 'codes': codes, 'resume': 200})
    print('PASS processing pause/resume', codes, flush=True)
    # Simulate an unavailable cancellation connection without granting more DB
    # privilege. The SQL deadline is still effective after the browser leaves.
    lock = lock_locations()
    pending = open_read(route, uid)
    pending2 = open_read(route, uid)
    until(lambda: len(active()) == 2)
    rows('ALTER ROLE gps_runtime CONNECTION LIMIT 1')
    rows("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='gps-location-cancel'")
    start_at = time.monotonic()
    disconnect(pending)
    disconnect(pending2)
    try:
        time.sleep(4)
        assert request(route, uid)[0] == 429, 'failed cancellation released admission too early'
        elapsed = until(lambda: not active(), timeout=24)
    finally:
        rows('ALTER ROLE gps_runtime CONNECTION LIMIT -1')
        lock.rollback()
        lock.close()
    assert time.monotonic() - start_at < 24
    assert request(route, uid)[0] == 200
    save('query114-cancel-fallback.json', {'passed': True, 'deadline_seconds': time.monotonic() - start_at,
        'normal_pool_recovered': True, 'admission_retained_during_cancel_outage': True,
        'runtime_superuser': False, 'extra_signal_role': False})
    print('PASS cancellation-channel outage remains bounded', elapsed, flush=True)


def refresh():
    shutil.copy2(OUT / 'gps-tracker-api', OUT / 'candidate114')
    start('candidate114')


if __name__ == '__main__':
    assert JOB.is_dir() and JOB.resolve() == JOB
    {'prepare': prepare, 'test': test, 'extra': extra, 'refresh': refresh}[sys.argv[1]]()
