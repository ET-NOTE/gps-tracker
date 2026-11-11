"""Bounded multi-device workload. Fixed disposable Docker network; no production DSN.

Seeds with the pinned 114 baseline, then tests the 115 candidate. All identities, keys and coordinates are
synthetic. Resource limits approximate VPS budgets, not its disk performance.
"""
import argparse
import base64
from collections import Counter, defaultdict
import concurrent.futures
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import random
import shutil
import ssl
import subprocess
import sys
import threading
import time
from urllib.parse import quote

import psycopg2

JOB = Path('/home/etcom-hub/build/gps-provision22-20261111query115')
OUT = JOB / 'out'
NET, DB, API, API2, PROXY, VOL = ['gps-query115-' + x for x in ('test', 'db', 'api', 'api2', 'proxy', 'data')]
IMAGE = 'gps-build:rust1.88-node22.22.2'
SHA = 'fc8f97815eb02fc0ee9ca92e1788444f30398532bb670b6ed8d2178cb9565429'
JWT = 'query115-synthetic-only-jwt-secret-32'
MONTH = 'since=2026-09-30T15:00:00Z&until=2026-10-31T15:00:00Z'
PERIOD = 'from=2026-10-01&to=2026-10-31'


def run(*args, **kw):
    return subprocess.run(args, check=True, **kw)


def info(kind, name):
    return json.loads(subprocess.check_output(['docker', kind, 'inspect', name]))[0]


def ip(name):
    assert info('network', NET)['Internal']
    item = info('container', name)
    assert not item['HostConfig']['PortBindings']
    assert set(item['NetworkSettings']['Networks']) == {NET}
    return item['NetworkSettings']['Networks'][NET]['IPAddress']


def connect():
    db = psycopg2.connect(host=ip(DB), user='postgres', password='query115-test-only', dbname='gps_query115_test')
    db.autocommit = True
    with db.cursor() as cur:
        cur.execute("SET statement_timeout='120s'; SET lock_timeout='5s'; SET jit=off")
        key = JOB / 'test-keys.json'
        if key.exists():
            cur.execute("SELECT set_config('gps.storage_keys',%s,false)", (key.read_text(),))
    return db


def sql(query, args=None):
    db = connect()
    try:
        with db.cursor() as cur:
            cur.execute(query, args)
            return cur.fetchall() if cur.description else []
    finally:
        db.close()


def save(name, value):
    (OUT / (name + '.json')).write_text(json.dumps(value, indent=2, ensure_ascii=False, default=str) + '\n')


def token(uid):
    def enc(v):
        return base64.urlsafe_b64encode(json.dumps(v, separators=(',', ':')).encode()).rstrip(b'=')
    now = int(time.time())
    raw = enc({'alg': 'HS256', 'typ': 'JWT'}) + b'.' + enc({'sub': str(uid), 'typ': 'access', 'iat': now, 'exp': now + 14400})
    return (raw + b'.' + base64.urlsafe_b64encode(hmac.new(JWT.encode(), raw, hashlib.sha256).digest()).rstrip(b'=')).decode()


def private(name, value):
    with os.fdopen(os.open(JOB / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
        json.dump(value, f)


def start(name=API, poll=300):
    secret = json.loads((JOB / 'test-runtime.json').read_text())
    subnet = info('network', NET)['IPAM']['Config'][0]['Subnet']
    proxy_ip = subnet.rsplit('.', 1)[0] + '.10'
    storage = JOB / ('storage-' + name)
    (storage / 'uploads').mkdir(parents=True, exist_ok=True)
    (storage / 'private').mkdir(exist_ok=True)
    run('docker', 'run', '-d', '--name', name, '--network', NET, '--cpus=2', '--memory=550m', '--pids-limit=128',
        '--user', f'{os.getuid()}:{os.getgid()}', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '-v', f'{OUT}/gps-tracker-api:/api:ro', '-v', f'{JOB}/test-keys.json:/keys.json:ro', '-v', f'{storage}:/storage',
        '-e', 'APP_ENV=test', '-e', 'BIND_ADDR=0.0.0.0:3043', '-e', 'GPS_DATABASE_MODE=runtime',
        '-e', f'DATABASE_URL=postgres://gps_runtime:{quote(secret["password"])}@query115-db/gps_query115_test',
        '-e', 'JWT_SECRET=' + JWT, '-e', 'SMS_DEV_MODE=1', '-e', 'UPLOAD_DIR=/storage/uploads', '-e', 'PRIVATE_UPLOAD_DIR=/storage/private',
        '-e', 'GPS_LOCATION_ENCRYPTION=pilot', '-e', 'GPS_LOCATION_KEYRING_FILE=/keys.json',
        '-e', 'GPS_LOCATION_ACCESS_LOG=on', '-e', 'GPS_LOCATION_ACCESS_FLUSH_SECONDS=1', '-e', 'GPS_SUBJECT_PROVISION=on',
        '-e', 'GPS_INGEST_TLS_REQUIRED=on', '-e', 'GPS_TLS_TRUSTED_PROXIES=' + proxy_ip + '/32',
        '-e', 'GPS_STATS_POLL_SECONDS=' + str(poll), IMAGE, '/api', stdout=subprocess.DEVNULL)
    for _ in range(60):
        try:
            conn = http.client.HTTPConnection(ip(name), 3043, timeout=2)
            conn.request('GET', '/gps-tracker/health')
            r = conn.getresponse(); body = r.read(); conn.close()
            if r.status == 200 and json.loads(body)['db']:
                return
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(1)
    raise RuntimeError('API readiness timeout')


def setup():
    assert JOB.resolve() == JOB and shutil.disk_usage(JOB).free > 6 * 1024**3
    assert hashlib.sha256((OUT / 'gps-tracker-api').read_bytes()).hexdigest() == SHA
    run('docker', 'network', 'create', '--internal', NET, stdout=subprocess.DEVNULL)
    run('docker', 'volume', 'create', '--label', 'gps.query115=synthetic', VOL, stdout=subprocess.DEVNULL)
    run('docker', 'run', '-d', '--name', DB, '--network', NET, '--network-alias', 'query115-db', '--cpus=2', '--memory=1500m', '--pids-limit=256',
        '-v', VOL + ':/var/lib/postgresql/data', '-e', 'POSTGRES_PASSWORD=query115-test-only', '-e', 'POSTGRES_DB=gps_query115_test',
        'timescale/timescaledb:2.19.3-pg14', '-c', 'max_connections=50', '-c', 'shared_buffers=742MB', '-c', 'work_mem=2532kB',
        '-c', 'effective_cache_size=2225MB', '-c', 'jit=off', '-c', 'track_io_timing=on',
        '-c', 'log_parameter_max_length=0', '-c', 'log_parameter_max_length_on_error=0', stdout=subprocess.DEVNULL)
    for _ in range(60):
        try:
            if sql('SELECT 1') == [(1,)]: break
        except psycopg2.Error: pass
        time.sleep(1)
    run('docker', 'run', '--rm', '--network', NET, '--memory=550m', '-v', f'{OUT}/gps-tracker-api:/api:ro',
        '-e', 'APP_ENV=test', '-e', 'JWT_SECRET=' + JWT, '-e', 'GPS_MIGRATE_ONLY=1',
        '-e', 'DATABASE_URL=postgres://postgres:query115-test-only@query115-db/gps_query115_test', IMAGE, '/api', stdout=subprocess.DEVNULL)
    assert sql('SELECT max(version) FROM _sqlx_migrations') == [(112,)]
    private('test-keys.json', {'active': 'query115', 'keys': {'query115': base64.b64encode(os.urandom(32)).decode()}})
    sql('UPDATE location_storage_policy SET enabled=true,activated_at=now()')
    sql("UPDATE location_subject_policy SET enabled=true,reference='isolated-query115-policy',push_enabled=false")
    users = [x[0] for x in sql("INSERT INTO users(email,phone,password_hash) VALUES('query115-a@example.invalid','query115-a',''),('query115-b@example.invalid','query115-b','') RETURNING id")]
    for uid in users:
        sql("INSERT INTO subscriptions(user_id,kind,expires_at) VALUES(%s,'corporate_report',now()+interval '2 days')", (uid,))
        sql("INSERT INTO corporate_info(user_id,company_name,business_number) VALUES(%s,'Synthetic115','000-00-00000')", (uid,))
    devices = []
    for i in range(8):
        uid = users[i // 4]
        did = sql("INSERT INTO devices(owner_id,device_uid,api_key_hash,license_plate,car_model) VALUES(%s,%s,'',%s,%s) RETURNING id", (uid, f'query115-{i}', f'TEST-{i}', f'Synthetic car {i}'))[0][0]
        began = time.monotonic()
        # 31 KST days, 480 minute-batches/day, 6 distinct fixes each. Last
        # fix shares the raw timestamp so deduplication yields exactly 89,280/device.
        for day in range(31):
            sql("""INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,fixes_jsonb)
              SELECT %s,%s,t,'l80',true,35+%s*.01+m*.00001,127,
                (SELECT jsonb_agg(jsonb_build_object('at_ms',(-50+j*10)*1000,
                  'lat',35+%s*.01+m*.00001-(5-j)*.000001,'lng',127,'fix',true,'sat',12)) FROM generate_series(0,5) j)
              FROM (SELECT m,'2026-10-01T08:00:50+09:00'::timestamptz+%s*interval '1 day'+m*interval '1 minute' AS t
                    FROM generate_series(0,479) m) s""", (did, uid, i, i, day))
        sql("""INSERT INTO events(device_id,user_id,kind,occurred_at)
           SELECT %s,%s,k,'2026-10-01T08:00:00+09:00'::timestamptz+d*interval '1 day'+CASE WHEN k='sleep_enter' THEN interval '8 hours' ELSE interval '0' END
           FROM generate_series(0,30) d CROSS JOIN (VALUES('wake'),('sleep_enter')) kinds(k)""", (did, uid))
        devices.append({'device_id': did, 'user_id': uid, 'rows': 14880, 'unique_points': 89280})
        print('SEEDED', i + 1, 'seconds', round(time.monotonic() - began, 2), flush=True)
    sql('VACUUM ANALYZE location_records')
    sys.path.insert(0, str(JOB / 'src/ops'))
    from admin_db_roles import run as roles
    roles('postgres://postgres:query115-test-only@' + ip(DB) + '/gps_query115_test', True, JOB / 'test-runtime.json')
    save('fixture', {'devices': devices, 'users': users, 'rows': 119040, 'unique_points': 714240, 'schema': 112, 'api_sha256': SHA,
        'storage': 'Build-host NVMe named volume; not VPS disk', 'db_cpu': 2, 'db_memory_mib': 1500, 'api_cpu': 2, 'api_memory_mib': 550})
    mappings()
    start(poll=5)
    tls_setup()
    print('SETUP COMPLETE', flush=True)


def tls_setup():
    directory = JOB / 'tls'; directory.mkdir(exist_ok=True)
    address = info('network', NET)['IPAM']['Config'][0]['Subnet'].rsplit('.', 1)[0] + '.10'
    run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=query115.invalid',
        '-addext', 'subjectAltName=IP:' + address, '-keyout', str(directory / 'key.pem'), '-out', str(directory / 'cert.pem'), capture_output=True)
    os.chmod(directory / 'key.pem', 0o600)
    (directory / 'nginx.conf').write_text('pid /tmp/nginx.pid; events {} http { access_log off; client_body_temp_path /tmp/client; proxy_temp_path /tmp/proxy; fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi; '
       'server { listen 8443 ssl; ssl_protocols TLSv1.2 TLSv1.3; ssl_certificate /tls/cert.pem; ssl_certificate_key /tls/key.pem; '
       'location / { proxy_pass http://' + API + ':3043; proxy_read_timeout 90s; proxy_ignore_client_abort off; proxy_set_header X-GPS-TLS-Version $ssl_protocol; } } }')
    run('docker', 'run', '-d', '--name', PROXY, '--network', NET, '--ip', address, '--cpus=.25', '--memory=64m', '--pids-limit=64',
        '--user', f'{os.getuid()}:{os.getgid()}', '--cap-drop=ALL', '--security-opt=no-new-privileges', '-v', f'{directory}:/tls:ro',
        'nginx:stable-alpine', 'nginx', '-c', '/tls/nginx.conf', '-g', 'daemon off;', stdout=subprocess.DEVNULL)


class Client:
    def __init__(self, second=False):
        self.host = ip(API2 if second else PROXY)
        self.second = second
        self.tls = ssl.create_default_context(cafile=str(JOB / 'tls/cert.pem'))
        self.tls.minimum_version = self.tls.maximum_version = ssl.TLSVersion.TLSv1_2

    def get(self, path, uid=None, body=None, headers=None):
        conn = http.client.HTTPConnection(self.host, 3043, timeout=90) if self.second else http.client.HTTPSConnection(self.host, 8443, context=self.tls, timeout=90)
        started = time.monotonic()
        try:
            conn.request('POST' if body is not None else 'GET', path, body, headers or ({'Authorization': 'Bearer ' + token(uid)} if uid else {}))
            r = conn.getresponse(); data = r.read()
            return r.status, data, {k.lower(): v for k, v in r.getheaders()}, time.monotonic() - started
        finally:
            conn.close()


def fixture():
    return json.loads((OUT / 'fixture.json').read_text())


def mappings():
    result = []
    # Four personally owned SIMs and four mapped corporate SIMs. Legacy
    # unbounded readers must remain rejected for company subject mappings.
    for device in fixture()['devices'][4:]:
        did, uid = device['device_id'], device['user_id']
        subject = sql("INSERT INTO users(email,phone,password_hash) VALUES(%s,%s,'no-login') RETURNING id", (f'query115-subject-{did}@example.invalid', f'subject115-{did}'))[0][0]
        staff = sql("INSERT INTO staff(user_id,name,active) VALUES(%s,'Synthetic115',true) RETURNING id", (uid,))[0][0]
        sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)', (uid, staff, subject))
        vehicle = sql("INSERT INTO fleet_vehicles(owner_id,name,license_plate) VALUES(%s,%s,%s) RETURNING id", (uid, f'Synthetic115-{did}', f'TEST-{did}'))[0][0]
        binding = sql("INSERT INTO fleet_vehicle_bindings(owner_id,vehicle_id,device_id,terminal_name,started_at,is_primary) VALUES(%s,%s,%s,'SIM fixture','2026-09-01',true) RETURNING id", (uid, vehicle, did))[0][0]
        mid = sql("""INSERT INTO location_subject_mappings(request_key,owner_id,subject_id,proposed_by,staff_id,vehicle_id,binding_id,device_id,starts_at,ends_at,status,decided_at)
          VALUES(gen_random_uuid(),%s,%s,%s,%s,%s,%s,%s,'2026-10-01T00:00:00+09:00','2026-11-01T00:00:00+09:00','confirmed',now()) RETURNING id""", (uid, subject, uid, staff, vehicle, binding, did))[0][0]
        result.append({'device': did, 'mapping': mid, 'subject': subject, 'owner': uid, 'vehicle': vehicle})
    save('mappings', result)


def routes(did):
    root = f'/gps-tracker/api/v1/devices/{did}/locations'
    corp = '/gps-tracker/api/v1/corporate'
    return [('month_aggregate', root + '/aggregated?' + MONTH + '&bucket=1h'),
            ('month_history', root + '?' + MONTH + '&limit=10000'),
            ('month_page', root + '/page?' + MONTH + '&limit=5000'),
            ('fleet_trips', corp + f'/devices/{did}/trips?' + PERIOD),
            ('fleet_csv', corp + f'/devices/{did}/trips.csv?' + PERIOD),
            ('fleet_xlsx', corp + f'/report.xlsx?type=nts&month=2026-10&device_ids={did}')]


def probe():
    data = fixture(); client = Client(); result = []
    for device in data['devices']:
        did, uid = device['device_id'], device['user_id']
        selected = routes(did)[:3] if did in [x['device_id'] for x in data['devices'][:4]] else routes(did)[2:]
        for name, path in selected:
            status, body, _, elapsed = client.get(path, uid)
            item = {'device': did, 'route': name, 'status': status, 'seconds': elapsed, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
            result.append(item); save('probe', result)
            print('PROBE', item, flush=True)
            if status == 200:
                if name == 'fleet_xlsx': assert body[:2] == b'PK'
                elif name == 'fleet_csv': assert len(body.decode('utf-8-sig').splitlines()) >= 32
                elif name == 'fleet_trips': assert len(json.loads(body)) == 31
            else: item['error'] = body[:250].decode(errors='replace')
        foreign = data['users'][1] if uid == data['users'][0] else data['users'][0]
        assert client.get(routes(did)[2][1], foreign)[0] in (404, 503)
    save('probe', result)


def stats(values):
    ordered = sorted(values)
    return {'count': len(ordered), **({k: ordered[min(len(ordered) - 1, int((len(ordered) - 1) * q))] for k, q in [('p50', .5), ('p95', .95), ('max', 1)]} if ordered else {})}


def repair():
    begun = time.monotonic(); samples = []; target = 248
    while time.monotonic() - begun < 900:
        count = sql("SELECT count(*) FROM daily_stats WHERE device_id=ANY(%s) AND date BETWEEN '2026-10-01' AND '2026-10-31'", ([d['device_id'] for d in fixture()['devices']],))[0][0]
        samples.append({'elapsed': time.monotonic() - begun, 'days': count, 'queue': sql('SELECT count(*) FROM stats_rebuild_queue')[0][0]})
        save('repair', {'poll_seconds': 5, 'production_default_seconds': 300, 'samples': samples, 'complete': count == target})
        print('REPAIR', samples[-1], flush=True)
        if count == target: return
        time.sleep(10)
    raise AssertionError('bounded repair did not finish')


def load(label, seconds, workers, dual=False):
    assert 30 <= seconds <= 1800 and 2 <= workers <= 24
    assert shutil.disk_usage(JOB).free > 4 * 1024**3
    candidate_sha = hashlib.sha256((OUT / 'gps-tracker-api').read_bytes()).hexdigest()
    for name in ([API, API2] if dual else [API]):
        running_sha = subprocess.check_output(['docker', 'exec', name, 'sha256sum', '/proc/1/exe'], text=True).split()[0]
        assert running_sha == candidate_sha, (name, running_sha, candidate_sha)
    data = fixture(); secret = os.urandom(32); hardware = 'query115-load-' + str(time.time_ns())
    iccid = '89' + str(time.time_ns())[-17:]; uid = data['users'][0]
    ingest_did = sql("INSERT INTO devices(owner_id,device_uid,iccid,api_key_hash) VALUES(%s,%s,%s,'') RETURNING id", (uid, hardware, iccid))[0][0]
    sql('INSERT INTO hardware_credentials(auth_uid,key_digest,authorized_owner_id) VALUES(%s,%s,%s)', (hardware, secret, uid))
    # Default production poll for sustained load; setup/repair explicitly use 5s.
    before = sql('SELECT temp_bytes,temp_files,blk_read_time,blk_write_time FROM pg_stat_database WHERE datname=current_database()')[0]
    completed = []; attempts = []; health = []; ingest = []; resources = []; errors = []; walks = []
    stop = threading.Event(); begun = time.monotonic(); deadline = begun + seconds

    def reader(index):
        client = Client(dual and index % 2 == 1); n = 0; cursor = None; points = 0; pages = 0; walk_start = time.monotonic()
        device = data['devices'][index % 8]; did, owner = device['device_id'], device['user_id']
        while time.monotonic() < deadline and not stop.is_set():
            # First reader of each API walks all 18 pages; the others mix
            # heavy location reads and business report paths sharing admission.
            if index < (2 if dual else 1):
                name, path = routes(did)[2]
                if cursor: path += '&cursor=' + quote(cursor)
            else:
                choices = routes(did)[:3] if index % 8 < 4 else routes(did)[2:]
                if dual and index % 8 >= 4:
                    base = '/gps-tracker/api/v1/corporate'
                    choices += [('fleet_stats', base + '/fleet/trip-stats?' + PERIOD),
                                ('fleet_terminals', base + '/terminals?' + MONTH)]
                name, path = choices[(index + n) % len(choices)]
            started = time.monotonic(); status = 0
            try:
                for attempt in range(3):
                    status, body, headers, elapsed = client.get(path, owner)
                    attempts.append({'device': did, 'api': 2 if client.second else 1, 'route': name, 'status': status, 'seconds': elapsed})
                    if status != 429: break
                    parsed = json.loads(body)
                    retry = float(headers.get('retry-after', '0'))
                    if parsed.get('code') != 'location_read_busy' or attempt == 2 or retry > 9.5: break
                    if stop.wait(max(retry, 2**attempt) + random.random() * .499): return
                completed.append({'device': did, 'route': name, 'status': status, 'attempts': attempt + 1, 'seconds': time.monotonic() - started})
                if status == 200 and index < (2 if dual else 1):
                    parsed = json.loads(body); points += len(parsed['items']); pages += 1; cursor = parsed['next_cursor']
                    if not parsed['has_more']:
                        assert points == device['unique_points'], (points, device['unique_points'])
                        walks.append({'device': did, 'points': points, 'pages': pages, 'seconds': time.monotonic() - walk_start})
                        cursor = None; points = pages = 0; walk_start = time.monotonic()
                elif status not in (200, 429, 408):
                    errors.append({'device': did, 'route': name, 'status': status, 'body': body[:200].decode(errors='replace')})
            except Exception as error:
                errors.append({'device': did, 'route': name, 'error': type(error).__name__, 'detail': str(error)[:160]})
            n += 1
            stop.wait(.1)

    def background():
        client = Client(); counter = 0
        while time.monotonic() < deadline and not stop.is_set():
            counter += 1
            body = json.dumps({'device_uid': hardware, 'iccid': iccid, 'ts': counter, 'boot': 1,
                'l80': {'fix': True, 'lat': 37.123456, 'lng': 127.654321, 'sat': 12}, 'cbc_mv': 4100}, separators=(',', ':')).encode()
            signature = hmac.new(secret, f'{hardware}\n{counter}\n'.encode() + body, hashlib.sha256).hexdigest()
            headers = {'Content-Type': 'application/json', 'X-GPS-Auth-Version': '2', 'X-GPS-Uid': hardware,
                'X-GPS-Counter': str(counter), 'X-GPS-Signature': signature}
            try:
                status, _, _, elapsed = client.get('/gps-tracker/ingest', body=body, headers=headers)
                ingest.append({'status': status, 'seconds': elapsed})
                status, _, _, elapsed = client.get('/gps-tracker/health')
                health.append({'status': status, 'seconds': elapsed})
            except Exception as error:
                errors.append({'background': type(error).__name__, 'detail': str(error)[:120]})
            stop.wait(1)

    def snapshot():
        records = sql("SELECT count(*),count(*) FILTER(WHERE state='active'),count(*) FILTER(WHERE state='idle in transaction') FROM pg_stat_activity WHERE datname=current_database()")[0]
        names = [DB, API, PROXY] + ([API2] if dual else [])
        usage = subprocess.check_output(['docker', 'stats', '--no-stream', '--format', '{{json .}}', *names], text=True)
        item = {'elapsed': time.monotonic() - begun, 'db_connections': records[0], 'db_active': records[1], 'idle_transactions': records[2],
            'containers': [json.loads(line) for line in usage.splitlines()], 'free_gib': shutil.disk_usage(JOB).free / 1024**3}
        resources.append(item)
        save(label + '-progress', {'elapsed': item['elapsed'], 'completed': len(completed), 'attempts': len(attempts), 'errors': errors[-10:], 'resources': resources})
        print('LOAD', label, round(item['elapsed']), 'done', len(completed), 'attempts', len(attempts), 'errors', len(errors), 'connections', records, flush=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers + 1) as executor:
        futures = [executor.submit(reader, i) for i in range(workers)] + [executor.submit(background)]
        try:
            while time.monotonic() < deadline:
                snapshot()
                if len(errors) > 50 or shutil.disk_usage(JOB).free < 3 * 1024**3:
                    errors.append({'safety_stop': True}); break
                time.sleep(min(15, max(.1, deadline - time.monotonic())))
        finally:
            stop.set()
        for future in futures: future.result()
    after = sql('SELECT temp_bytes,temp_files,blk_read_time,blk_write_time FROM pg_stat_database WHERE datname=current_database()')[0]
    grouped = defaultdict(list)
    for entry in completed: grouped[entry['route']].append(entry)
    result = {'label': label, 'production_modified': False, 'requested_seconds': seconds, 'elapsed': time.monotonic() - begun, 'workers': workers,
        'workload': '8 SIMs, 31 dense KST days; personal reads and mapped Fleet reports; dual adds Fleet stats/terminals',
        'dual_api': dual, 'api_sha256': hashlib.sha256((OUT / 'gps-tracker-api').read_bytes()).hexdigest(), 'completed': dict(Counter(x['status'] for x in completed)), 'attempts': dict(Counter(x['status'] for x in attempts)),
        'per_device': {str(d['device_id']): dict(Counter(x['status'] for x in completed if x['device'] == d['device_id'])) for d in data['devices']},
        'per_route': {k: {'statuses': dict(Counter(x['status'] for x in v)), 'end_to_end': stats([x['seconds'] for x in v if x['status'] == 200])} for k, v in grouped.items()},
        'ingest': {'statuses': dict(Counter(x['status'] for x in ingest)), 'latency': stats([x['seconds'] for x in ingest])},
        'health': {'statuses': dict(Counter(x['status'] for x in health)), 'latency': stats([x['seconds'] for x in health])},
        'db_delta': dict(zip(['temp_bytes', 'temp_files', 'read_ms', 'write_ms'], [b-a for a,b in zip(before, after)])),
        'resources': resources, 'errors': errors, 'full_month_traversals': walks,
        'containers_final': {n: {k: info('container', n)['State'][k] for k in ('Running', 'OOMKilled', 'ExitCode')} for n in [DB, API, PROXY] + ([API2] if dual else [])},
        'ingest_saved_rows': sql('SELECT count(*) FROM location_records WHERE device_id=%s', (ingest_did,))[0][0]}
    save(label, result)
    print('RESULT', json.dumps({k: v for k, v in result.items() if k not in ('resources', 'errors')}, default=str), flush=True)


def cleanup():
    assert JOB.resolve() == JOB and JOB.name == 'gps-provision22-20261111query115'
    network = info('network', NET); assert network['Internal']
    names = {v['Name'] for v in network['Containers'].values()}
    assert names <= {DB, API, API2, PROXY}
    assert info('volume', VOL)['Labels'].get('gps.query115') == 'synthetic'
    save('final-state', {'schema': sql('SELECT max(version) FROM _sqlx_migrations')[0][0],
        'records': sql('SELECT count(*),count(*) FILTER(WHERE lat IS NOT NULL OR lng IS NOT NULL OR fixes_jsonb IS NOT NULL),count(*) FILTER(WHERE lat_sealed IS NOT NULL),count(*) FILTER(WHERE NOT query_bounds_ready) FROM location_records')[0],
        'active_reads': sql("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'gps-read-%'")[0][0],
        'idle_transactions': sql("SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction'")[0][0]})
    for name in names:
        ip(name)
        (OUT / (name + '.log')).write_bytes(subprocess.check_output(['docker', 'logs', name], stderr=subprocess.STDOUT))
        run('docker', 'rm', '-f', name, stdout=subprocess.DEVNULL)
    run('docker', 'network', 'rm', NET, stdout=subprocess.DEVNULL)
    run('docker', 'volume', 'rm', VOL, stdout=subprocess.DEVNULL)
    for relative in ['test-keys.json', 'test-runtime.json', 'failed-setup-key.json', 'tls', 'storage-' + API, 'storage-' + API2]:
        path = JOB / relative
        assert path.parent.resolve() == JOB and not path.is_symlink()
        if path.is_dir(): shutil.rmtree(path)
        else: path.unlink(missing_ok=True)
    save('cleanup', {'containers_removed': sorted(names), 'network_removed': NET, 'volume_removed': VOL, 'private_files_removed': True,
        'other_projects_modified': False, 'free_gib': shutil.disk_usage(JOB).free / 1024**3})


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['setup', 'mappings', 'tls_setup', 'probe', 'repair', 'start', 'dual', 'load', 'cleanup'])
    p.add_argument('--seconds', type=int, default=900); p.add_argument('--workers', type=int, default=8)
    p.add_argument('--label', default='single'); p.add_argument('--dual', action='store_true')
    a = p.parse_args(); OUT.mkdir(parents=True, exist_ok=True)
    if a.command == 'setup': setup()
    elif a.command == 'start': start()
    elif a.command == 'dual': start(API2)
    elif a.command == 'load': load(a.label, a.seconds, a.workers, a.dual)
    else: globals()[a.command]()
