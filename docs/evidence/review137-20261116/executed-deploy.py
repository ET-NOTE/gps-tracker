"""Pinned 99 -> 114 team-review deployment. No feature activation or load test.

Run as root on seriallog: stage | rehearse | apply | verify | cleanup.
Retains the existing production configuration. A failed migration rolls back
as one transaction; after commit, do NOT downgrade or discard new live writes.
"""
import base64
import hashlib
import hmac
import json
import os
import pathlib
import secrets
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

import psycopg2

RELEASE = 'review137-20261116-r1'
STAGE = pathlib.Path('/home/mmm/gps-artifacts') / RELEASE
PAYLOAD = STAGE / 'payload'
BACKUP = pathlib.Path('/home/mmm/backups') / RELEASE
WEB = pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
DEST = pathlib.Path('/home/mmm/releases') / RELEASE / 'web'
ENV = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
API = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
CLONE = 'gps_tracker_review137'
RESTORED = 'gps_tracker_review137_restore'
BACKDB = 'gps_tracker_review137_backup99'
UNIT = 'gps-review137'
OLD_API = 'fa1e51e3d39473ca2852ac6b2899790547fa6667bb7337c646d29258a3e1c0fe'
OLD_ENV = 'fab21aeaaef7a00f1283530e1136690c28d416d5d4d62b9968d4a6a6cdb3df55'
OLD_WEB = '/home/mmm/releases/privacy-facts-20261106-r1/web'
ARCHIVE = '2a5ac4f7c27e4f385e7d13ebe42240993196facaafcd481be2815c2076e55668'
NEW_API = 'c6475670005ce79718d452ce882165f48a9e549249b97aad010f9247a0747cf8'
TIMERS = ['gps-privacy-accounts.timer', 'gps-privacy-files.timer']
OFF = ['GPS_ADMIN_SECURITY', 'GPS_LOCATION_ENCRYPTION', 'GPS_LOCATION_ACCESS_LOG',
       'GPS_SUBJECT_PROVISION', 'GPS_INGEST_TLS_REQUIRED']


def require(ok, reason):
    if not ok:
        raise RuntimeError(reason)


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for part in iter(lambda: f.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def run(args, **kw):
    result = subprocess.run(args, capture_output=True, **kw)
    if result.returncode:
        # Commands contain no credentials; error text can contain private rows.
        error = STAGE / ('command-error-' + str(time.time_ns()) + '.txt')
        error.write_bytes(result.stderr)
        error.chmod(0o600)
        raise RuntimeError(f'{args[0]} exited {result.returncode}; protected diagnostic: {error}')
    return result.stdout.decode()


def config():
    return {k: v.strip().strip('"').strip("'") for k, v in
            (line.split('=', 1) for line in ENV.read_text().splitlines()
             if '=' in line and not line.lstrip().startswith('#'))}


def process_env():
    pid = run(['systemctl', 'show', 'gps-tracker-api', '-pMainPID', '--value']).strip()
    return dict(x.split('=', 1) for x in pathlib.Path('/proc', pid, 'environ').read_text().split('\0') if '=' in x)


def url(clone=False):
    u = urllib.parse.urlsplit(config()['DATABASE_URL'])
    require(u.hostname in ('localhost', '127.0.0.1') and u.path == '/gps_tracker', 'unexpected DB endpoint')
    target = CLONE if clone is True else clone
    require(not target or target in (CLONE, RESTORED, BACKDB), 'unknown isolated database')
    return urllib.parse.urlunsplit(u._replace(path='/' + target)) if target else config()['DATABASE_URL']


def psql(database, sql):
    return run(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', database, '-c', sql])


def record(name, data):
    data = {'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), **data}
    (STAGE / (name + '.json')).write_text(json.dumps(data, indent=2))
    print(json.dumps(data), flush=True)
    return data


def state():
    with psycopg2.connect(url()) as db:
        db.set_session(readonly=True)
        with db.cursor() as q:
            q.execute('SELECT max(version) FROM _sqlx_migrations WHERE success')
            schema = q.fetchone()[0]
            q.execute('SELECT count(*) FROM users'); users = q.fetchone()[0]
            q.execute('SELECT count(*) FROM devices'); devices = q.fetchone()[0]
    return {'schema': schema, 'users': users, 'devices': devices, 'api': sha(API),
            'env': sha(ENV), 'web': str(WEB.resolve()), 'neighbors': neighbors()}


def neighbors():
    return {'dev_api': sha('/home/gps-dev/projects/gps-tracker-api/bin/gps-tracker-api-dev'),
            'dev_web': str(pathlib.Path('/home/gps-dev/gps-tracker-web-dev/dist').resolve()),
            'shield': str(pathlib.Path('/srv/shield/current').resolve()),
            'services': run(['systemctl', 'show', 'gps-tracker-api-dev', 'shield-api',
                             'gps-pdf-render.socket', '-pId', '-pMainPID', '-pActiveEnterTimestamp']),
            'nginx': sha('/etc/nginx/sites-available/gps.serial.kr')}


def migration_files():
    return sorted((PAYLOAD / 'sources/gps-tracker-api/migrations').glob('*.sql'))


def checksums(q, version):
    q.execute('SELECT version,encode(checksum,\'hex\') FROM _sqlx_migrations WHERE success ORDER BY version')
    found = dict(q.fetchall())
    expected = {int(p.name.split('_')[0]): hashlib.sha384(p.read_bytes()).hexdigest()
                for p in migration_files() if int(p.name.split('_')[0]) <= version}
    require(found == expected and max(found) == version, 'migration history/checksum mismatch')


def guard():
    require(sha(STAGE / 'candidate.tar.gz') == ARCHIVE, 'archive drift')
    with tarfile.open(STAGE / 'candidate.tar.gz') as archive:
        manifest = json.load(archive.extractfile('manifest.json'))
    for name, detail in manifest['files'].items():
        require(sha(PAYLOAD / name) == detail['sha256'], 'payload drift: ' + name)
    require(sha(API) == OLD_API and sha(ENV) == OLD_ENV and str(WEB.resolve()) == OLD_WEB,
            'production baseline drift')
    require(shutil.disk_usage('/').free > 3 * 1024**3, 'less than 3 GiB free')
    e = process_env()
    require(all(e.get(k, 'off') in ('off', '', '0', 'false') for k in OFF), 'activation flag differs')
    require(e.get('GPS_DATABASE_MODE', '') != 'runtime', 'DB execution mode differs')
    require(e.get('GPS_PDF_SOCKET') == '/run/gps-pdf-render/render.sock', 'PDF service differs')
    with psycopg2.connect(url()) as db:
        db.set_session(readonly=True)
        with db.cursor() as q:
            checksums(q, 99)
    require(run(['systemctl', 'is-active', *TIMERS]).split() == ['active', 'active'], 'timer state differs')


def stage():
    require(sha(STAGE / 'candidate.tar.gz') == ARCHIVE, 'archive hash mismatch')
    require(not PAYLOAD.exists(), 'payload already exists')
    PAYLOAD.mkdir(mode=0o755)
    with tarfile.open(STAGE / 'candidate.tar.gz') as t:
        for item in t.getmembers():
            target = (PAYLOAD / item.name).resolve()
            require(target.is_relative_to(PAYLOAD) and (item.isfile() or item.isdir()), 'unsafe archive member')
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with t.extractfile(item) as source, target.open('wb') as dest:
                    shutil.copyfileobj(source, dest)
    m = json.loads((PAYLOAD / 'manifest.json').read_text())
    for name, detail in m['files'].items():
        require(sha(PAYLOAD / name) == detail['sha256'], 'payload mismatch: ' + name)
    for p in [PAYLOAD, *PAYLOAD.rglob('*')]:
        p.chmod(0o755 if p.is_dir() else 0o644)
    (PAYLOAD / 'api/gps-tracker-api').chmod(0o755)
    require(sha(PAYLOAD / 'api/gps-tracker-api') == NEW_API, 'API mismatch')
    guard()
    record('staged', {'baseline': state(), 'archive': ARCHIVE, 'verified_files': len(m['files']),
                      'activation': 'unchanged/off', 'scope': 'team review; not service readiness'})


def dump(path, database='gps_tracker'):
    # Root opens the destination; postgres only receives its inherited descriptor.
    with path.open('xb') as out:
        result = subprocess.run(['runuser', '-u', 'postgres', '--', 'pg_dump', '-Fc', '-d', database],
                                stdout=out, stderr=subprocess.PIPE)
    require(result.returncode == 0 and path.stat().st_size > 0, 'database backup failed')
    path.chmod(0o600)
    toc = run(['pg_restore', '--list', str(path)])
    require('TABLE DATA _timescaledb_internal' in toc and '_sqlx_migrations' in toc, 'backup lacks tables')
    return {'bytes': path.stat().st_size, 'sha256': sha(path)}


def copy_database(source, target):
    """Physical per-database snapshot; never restart the shared PostgreSQL cluster.

    The caller stops the GPS API/timers for a production source. Connections are
    fenced only while PostgreSQL copies the template; the finally always opens it.
    """
    require(source in ('gps_tracker', CLONE) and target in (CLONE, RESTORED, BACKDB), 'invalid snapshot names')
    require(not psql('postgres', f"SELECT 1 FROM pg_database WHERE datname='{target}'").strip(), 'snapshot exists')
    psql('postgres', 'ALTER DATABASE ' + source + ' ALLOW_CONNECTIONS false')
    try:
        psql('postgres', f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='{source}'")
        psql('postgres', f'CREATE DATABASE {target} WITH TEMPLATE {source} OWNER gps_tracker_app ALLOW_CONNECTIONS false')
        psql('postgres', f"ALTER DATABASE {target} SET timescaledb.restoring='on'")
        psql('postgres', 'ALTER DATABASE ' + target + ' ALLOW_CONNECTIONS true')
        psql(target, 'SELECT alter_job(job_id,scheduled=>false) FROM timescaledb_information.jobs')
        psql(target, 'SELECT timescaledb_post_restore()')
    finally:
        psql('postgres', 'ALTER DATABASE ' + source + ' ALLOW_CONNECTIONS true')


def decompress_snapshot(database):
    require(database in (RESTORED, BACKDB), 'never decompress production or migration test')
    before = fingerprint(url(database))
    result = psql(database, "SELECT decompress_chunk(format('%I.%I',chunk_schema,chunk_name)::regclass) FROM timescaledb_information.chunks WHERE is_compressed")
    require(before == fingerprint(url(database)), 'snapshot decompression changed logical rows')
    return len(result.splitlines())


def restore_dump(database, path):
    require(database == RESTORED, 'restore target must be disposable')
    psql('postgres', 'DROP DATABASE IF EXISTS ' + database + ' WITH (FORCE)')
    psql('postgres', 'CREATE DATABASE ' + database + ' OWNER gps_tracker_app')
    psql(database, 'CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();')
    with path.open('rb') as source:
        run(['runuser', '-u', 'postgres', '--', 'pg_restore', '--exit-on-error', '-d', database], stdin=source)
    psql(database, 'SELECT timescaledb_post_restore();')
    psql(database, 'SELECT alter_job(job_id,scheduled=>false) FROM timescaledb_information.jobs')


def fingerprint(database_url):
    """Hashes only. No row data or locations leave the host."""
    result = {}
    with psycopg2.connect(database_url) as db:
        db.set_session(readonly=True)
        with db.cursor() as q:
            for table, order in [('users', 'id'), ('devices', 'id'), ('device_data_controls', 'device_id'),
                                 ('privacy_account_controls', 'user_id'), ('location_records', 'device_id,recorded_at,source')]:
                # Compare the old columns even after the schema adds new columns.
                q.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=%s ORDER BY ordinal_position", (table,))
                columns = [r[0] for r in q.fetchall() if not r[0].endswith('_sealed') and r[0] not in
                           ('query_first_at', 'query_last_at', 'query_bounds_ready')]
                names = ','.join('"' + c + '"' for c in columns)
                q.execute(f'SELECT md5(coalesce(string_agg(row_to_json(t)::text,\'\'),\'\')),count(*) FROM (SELECT {names} FROM {table} ORDER BY {order}) t')
                result[table] = q.fetchone()
    return result


def migrate(database_url):
    started = time.monotonic()
    with psycopg2.connect(database_url) as db:
        with db.cursor() as q:
            q.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'")
            checksums(q, 99)
            for p in migration_files():
                version = int(p.name.split('_')[0])
                if version <= 99:
                    continue
                require(version <= 114, 'unreviewed migration')
                sql = p.read_bytes()
                q.execute(sql.decode())
                description = p.stem.split('_', 1)[1].replace('_', ' ')
                q.execute('INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(%s,%s,true,%s,0)',
                          (version, description, psycopg2.Binary(hashlib.sha384(sql).digest())))
            checksums(q, 114)
    return round(time.monotonic() - started, 3)


def request(path, port=3042, token=None):
    req = urllib.request.Request(f'http://127.0.0.1:{port}/gps-tracker' + path)
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, None


def health(port, release):
    for _ in range(25):
        try:
            status, data = request('/health', port)
            if status == 200 and data['ok'] and data['release'] == release:
                return data
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('API health did not reach expected release')


def token(uid, key):
    def b64(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    now = int(time.time())
    signed = b64({'alg': 'HS256', 'typ': 'JWT'}) + '.' + b64({'sub': str(uid), 'iat': now, 'exp': now + 300, 'typ': 'access'})
    return signed + '.' + base64.urlsafe_b64encode(hmac.new(key.encode(), signed.encode(), hashlib.sha256).digest()).decode().rstrip('=')


def policies(database_url):
    with psycopg2.connect(database_url) as db:
        db.set_session(readonly=True)
        with db.cursor() as q:
            result = {}
            for table in ['location_storage_policy', 'privacy_retention_policy', 'location_subject_policy']:
                q.execute('SELECT enabled FROM ' + table)
                result[table] = q.fetchone()[0]
            require(not any(result.values()), 'policy unexpectedly enabled')
    return result


def rehearse():
    guard()
    require(not psql('postgres', "SELECT 1 FROM pg_database WHERE datname='" + CLONE + "'").strip(), 'clone already exists')
    private = STAGE / 'private'
    private.mkdir(mode=0o700, exist_ok=True)
    run(['systemctl', 'stop', *TIMERS, 'gps-tracker-api'])
    try:
        for timer in TIMERS:
            require(subprocess.run(['systemctl', 'is-active', timer.replace('.timer', '.service')], capture_output=True).stdout.decode().strip() in ('inactive', 'failed'), 'cleanup already running')
        copy_database('gps_tracker', CLONE)
    finally:
        run(['systemctl', 'start', 'gps-tracker-api', *TIMERS])
    health(3040, 'privacy-log-20261107-r1')
    copy_database(CLONE, RESTORED)
    chunks = decompress_snapshot(RESTORED)
    snapshot = private / 'rehearsal-uncompressed.dump'
    backup = dump(snapshot, RESTORED)
    expected = fingerprint(url(RESTORED))
    restore_dump(RESTORED, snapshot)
    require(expected == fingerprint(url(RESTORED)), 'restored business rows differ')
    before = fingerprint(url(True))
    elapsed = migrate(url(True))
    require(before == fingerprint(url(True)), 'migration changed original business rows')
    policy = policies(url(True))
    rehearsal_api_smoke(private)
    guard()
    record('rehearsal', {'passed': True, 'script_sha256': sha(__file__), 'api_sha256': NEW_API,
                         'source_schema': 99, 'target_schema': 114, 'migration_seconds': elapsed,
                         'backup_restore_verified': backup, 'original_row_hashes_unchanged': True,
                         'compressed_snapshot_migrated': True, 'backup_snapshot_decompressed_chunks': chunks,
                         'policies': policy, 'production_unchanged': True,
                         'load_test_added': False})


def rehearsal_api_smoke(private):
    appdir = STAGE / 'smoke-files'
    appdir.mkdir(mode=0o700, exist_ok=True)
    shutil.chown(appdir, user='gps-api', group='gps-api')
    key = secrets.token_hex(32)
    test_env = {'PATH': '/usr/bin:/bin', 'DATABASE_URL': url(True), 'JWT_SECRET': key,
                'APP_ENV': 'test', 'BIND_ADDR': '127.0.0.1:3042', 'SMS_DEV_MODE': '1',
                'UPLOAD_DIR': str(appdir), 'PRIVATE_UPLOAD_DIR': str(appdir), 'RUST_LOG': 'warn',
                **{k: 'off' for k in OFF}}
    envfile = private / 'smoke.env'
    envfile.write_text('\n'.join(k + '=' + v for k, v in test_env.items()) + '\n')
    envfile.chmod(0o600)
    command = ['systemd-run', '--unit=' + UNIT, '--collect', '-pUser=gps-api', '-pGroup=gps-api',
               '-pWorkingDirectory=' + str(appdir), '-pEnvironmentFile=' + str(envfile),
               '-pIPAddressDeny=any', '-pIPAddressAllow=localhost', '-pProtectSystem=strict',
               '-pReadWritePaths=' + str(appdir), '-pNoNewPrivileges=yes', '-pPrivateTmp=yes',
               '-pMemoryMax=350M', '-pCPUQuota=50%', str(PAYLOAD / 'api/gps-tracker-api')]
    run(command)
    try:
        health(3042, 'runtime136-20261116-r1')
        with psycopg2.connect(url(True)) as db:
            with db.cursor() as q:
                q.execute("SELECT id FROM users WHERE email='user@user4.com'")
                row = q.fetchone(); require(row, 'authorized test account missing')
                uid = row[0]
        access = token(uid, key)
        checks = {}
        for path in ['/api/v1/auth/me', '/api/v1/auth/me/prefs', '/api/v1/devices',
                     '/api/v1/privacy/requests/page', '/api/v1/privacy/collection']:
            status, _ = request(path, token=access)
            checks[path] = status
            require(status == 200, 'compatibility endpoint failed: ' + path + ' ' + str(status))
        status, _ = request('/api/v1/privacy/requests/page')
        require(status == 401, 'private route allows anonymous access')
        checks['anonymous_private_request'] = status
        record('smoke', {'passed': True, 'checks': checks,
                         'external_credentials': 'absent', 'egress': 'systemd IPAddressDeny=any; allow localhost',
                         'files': 'isolated scratch directory', 'production_authentication': False})
    finally:
        run(['systemctl', 'stop', UNIT])
        envfile.unlink(missing_ok=True)


def apply():
    guard()
    r = json.loads((STAGE / 'rehearsal.json').read_text())
    require(r['passed'] and r['script_sha256'] == sha(__file__) and r['api_sha256'] == NEW_API,
            'exact deploy script and API have not passed rehearsal')
    require(not BACKUP.exists() and not DEST.parent.exists(), 'release/backup already exists')
    BACKUP.mkdir(mode=0o700)
    baseline = state()
    (BACKUP / 'baseline.json').write_text(json.dumps(baseline, indent=2))
    shutil.copy2(API, BACKUP / 'api.previous')
    shutil.copy2(ENV, BACKUP / 'environment.previous')
    shutil.copytree(PAYLOAD / 'web', DEST)
    # Keep hashed assets referenced by tabs that were already open.
    for old in (WEB / 'assets').iterdir():
        if old.is_file() and not (DEST / 'assets' / old.name).exists():
            shutil.copy2(old, DEST / 'assets' / old.name)
    if (WEB / 'uploads').is_symlink():
        (DEST / 'uploads').symlink_to((WEB / 'uploads').resolve(), target_is_directory=True)
    (DEST / 'version.json').write_text(json.dumps({'release': RELEASE, 'api_release': 'runtime136-20261116-r1',
                                                'schema': 114, 'purpose': 'team review', 'feature_activation': False}))
    for p in [DEST.parent, DEST, *DEST.rglob('*')]:
        if not p.is_symlink():
            p.chmod(0o755 if p.is_dir() else 0o644)
    next_api = API.with_name(API.name + '.review137')
    require(not next_api.exists(), 'pending API exists')
    shutil.copy2(PAYLOAD / 'api/gps-tracker-api', next_api)
    next_api.chmod(0o755)
    shutil.chown(next_api, user=API.stat().st_uid, group=API.stat().st_gid)
    require(sha(next_api) == NEW_API, 'staged API copy differs')
    started = time.time()
    committed = False
    run(['systemctl', 'stop', *TIMERS])
    try:
        # A timer's already-running oneshot must finish before migration begins.
        for timer in TIMERS:
            service = timer.replace('.timer', '.service')
            active = subprocess.run(['systemctl', 'is-active', service], capture_output=True).stdout.decode().strip()
            require(active in ('inactive', 'failed'), 'cleanup service is still running')
        run(['systemctl', 'stop', 'gps-tracker-api'])
        copy_database('gps_tracker', BACKDB)
        chunks = decompress_snapshot(BACKDB)
        backup = dump(BACKUP / 'database.dump', BACKDB)
        before = fingerprint(url())
        elapsed = migrate(url())
        committed = True
        require(before == fingerprint(url()), 'original business rows changed during migration')
        policies(url())
        os.replace(next_api, API)
        run(['systemctl', 'start', 'gps-tracker-api'])
        h = health(3040, 'runtime136-20261116-r1')
        link = WEB.with_name('dist-root.review137')
        require(not link.exists() and not link.is_symlink(), 'pending web link exists')
        link.symlink_to(DEST)
        os.replace(link, WEB)
        require(sha(ENV) == OLD_ENV and neighbors() == baseline['neighbors'], 'configuration/neighbor drift')
        record('deployment', {'passed': True, 'schema': 114, 'health': h,
                              'script_sha256': sha(__file__), 'api_sha256': sha(API), 'web': str(WEB.resolve()),
                              'migration_seconds': elapsed, 'elapsed_seconds': round(time.time()-started, 3),
                              'backup': backup, 'backup_directory': str(BACKUP), 'original_row_hashes_unchanged': True,
                              'backup_database': BACKDB, 'backup_decompressed_chunks': chunks,
                              'configuration_unchanged': True, 'neighbors_unchanged': True,
                              'rollback': 'post-commit forward repair; never overwrite new live writes'})
    except Exception:
        if not committed:
            run(['systemctl', 'start', 'gps-tracker-api'])
        else:
            record('needs-repair', {'committed': True, 'note': 'Do not downgrade or restore over new live writes; investigate first.'})
        raise
    finally:
        run(['systemctl', 'start', *TIMERS])


def verify():
    require(sha(API) == NEW_API and sha(ENV) == OLD_ENV and WEB.resolve() == DEST, 'deployment differs')
    with psycopg2.connect(url()) as db:
        db.set_session(readonly=True)
        with db.cursor() as q:
            checksums(q, 114)
    h = health(3040, 'runtime136-20261116-r1')
    with urllib.request.urlopen('https://gps.serial.kr/health', timeout=20) as response:
        require(json.load(response) == h, 'external health differs')
    manifest = json.loads((PAYLOAD / 'manifest.json').read_text())
    public_files = ['web/index.html'] + [p for p in manifest['files'] if p.startswith('web/assets/')]
    for path in public_files:
        remote = '/profile' if path == 'web/index.html' else '/' + path.removeprefix('web/')
        with urllib.request.urlopen('https://gps.serial.kr' + remote, timeout=20) as response:
            require(hashlib.sha256(response.read()).hexdigest() == manifest['files'][path]['sha256'], 'served file mismatch')
    before = json.loads((STAGE / 'staged.json').read_text())['baseline']
    require(neighbors() == before['neighbors'], 'neighbors changed')
    require(run(['systemctl', 'is-active', *TIMERS]).split() == ['active', 'active'], 'timers not restored')
    e = process_env()
    require(all(e.get(k, 'off') in ('off', '', '0', 'false') for k in OFF), 'feature activation changed')
    record('verified', {'passed': True, 'state': state(), 'health': h, 'public_files_verified': len(public_files),
                        'policies': policies(url()), 'feature_flags': {k: e.get(k, '<unset/off>') for k in OFF},
                        'pdf_socket': e.get('GPS_PDF_SOCKET'), 'timers_active': True,
                        'disk_available_bytes': shutil.disk_usage('/').free})


def cleanup():
    require((STAGE / 'rehearsal.json').exists(), 'retain failed rehearsal for diagnosis')
    subprocess.run(['systemctl', 'stop', UNIT], capture_output=True)
    psql('postgres', 'DROP DATABASE IF EXISTS ' + CLONE + ' WITH (FORCE)')
    psql('postgres', 'DROP DATABASE IF EXISTS ' + RESTORED + ' WITH (FORCE)')
    # This dump belongs only to the disposable clone; retain the production backup.
    (STAGE / 'private/rehearsal.dump').unlink(missing_ok=True)
    (STAGE / 'private/rehearsal-uncompressed.dump').unlink(missing_ok=True)
    (STAGE / 'private/smoke.env').unlink(missing_ok=True)
    record('cleanup', {'clone_removed': True, 'rehearsal_dump_removed': True, 'production_backup_retained': BACKUP.exists()})


if __name__ == '__main__':
    os.umask(0o077)
    require(os.geteuid() == 0, 'root required')
    require(len(sys.argv) == 2 and sys.argv[1] in ('stage', 'rehearse', 'apply', 'verify', 'cleanup'), 'invalid mode')
    globals()[sys.argv[1]]()
