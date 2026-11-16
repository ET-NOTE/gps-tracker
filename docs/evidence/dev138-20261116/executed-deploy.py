"""Dev-only UI/API alignment. Pinned artifacts, preserved dev data, no activation.

Run on seriallog as root: prepare | rehearse | apply | verify | cleanup.
Production services, configuration and data are never deployment targets.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess as sp
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

import psycopg2

RELEASE = 'dev-aligned-20261116-r1'
HOME = Path('/home/gps-dev')
STAGE = Path('/home/mmm/gps-artifacts') / RELEASE
BACKUP = HOME / 'backups' / RELEASE
DEST = HOME / 'releases' / RELEASE
WORK = HOME / 'workspace/gps-tracker'
ENV = HOME / 'projects/gps-tracker-api/.env.dev'
API = HOME / 'projects/gps-tracker-api/bin/gps-tracker-api-dev'
WEB = HOME / 'gps-tracker-web-dev/dist'
DB = 'gps_tracker_dev_next_20260924'
CLONE = 'gps_tracker_dev_align138_check'
BACKDB = 'gps_tracker_dev_align138_backup72'
ROLE = 'gps_tracker_dev_app'
UNIT = 'gps-dev-align138-check'
SOURCE = 'a4c6cb0801c9aeac10a0bd8343a01c9bdd592f06'
OLD_SOURCE = 'bce96c634bca240aaa239f854216d84a5e000155'
NEW_BRANCH = 'codex/dev-aligned-20261116'
OLD_API = '35323e272cccc81843fa33442fb27dfa08f0f01b3f5133b15d4f9bbf28abd62b'
NEW_API = '62f67f352bcdc677273a88caa7c44b4c409d760c97b9da9128f734da790f648d'
API_RELEASE = 'review137-20261116-r3'
OLD_ENV = '9cd39266e935b927e300377ee8ebbbb40b843e990004fd15a50aeeb309150a0a'
OFF = ['GPS_ADMIN_SECURITY', 'GPS_LOCATION_ENCRYPTION', 'GPS_LOCATION_ACCESS_LOG',
       'GPS_SUBJECT_PROVISION', 'GPS_INGEST_TLS_REQUIRED']


def run(args, **kw):
    r = sp.run([str(a) for a in args], capture_output=True, **kw)
    if r.returncode:
        error = STAGE / ('error-' + str(time.time_ns()) + '.txt')
        error.write_bytes(r.stderr); error.chmod(0o600)
        raise RuntimeError(f'{args[0]} failed; protected diagnostic: {error}')
    return r.stdout.decode().strip()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(name, data):
    data = {'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), **data}
    (STAGE / (name + '.json')).write_text(json.dumps(data, indent=2) + '\n')
    print(json.dumps(data), flush=True)
    return data


def config():
    e = {k: v.strip().strip('"').strip("'") for k, v in
         (s.split('=', 1) for s in ENV.read_text().splitlines() if '=' in s and not s.lstrip().startswith('#'))}
    u = urllib.parse.urlsplit(e['DATABASE_URL'])
    assert u.hostname in ('localhost', '127.0.0.1') and u.path == '/' + DB and u.username == ROLE
    assert e['APP_ENV'] == 'development' and e['BIND_ADDR'] == '127.0.0.1:3041'
    assert e['SMS_DEV_MODE'] == '1' and sha(ENV) == OLD_ENV
    assert all(e.get(k, 'off') in ('off', '', '0', 'false') for k in OFF)
    for k in ('FCM_SERVICE_ACCOUNT_PATH', 'TOSS_SECRET_KEY', 'TOSS_WEBHOOK_SECRET',
              'OPENAI_API_KEY', 'ONCE_API_TOKEN', 'ONCE_API_CLIENT_SECRET'):
        assert not e.get(k), k
    return e


def url(database=DB):
    assert database in (DB, CLONE, BACKDB)
    return urllib.parse.urlunsplit(urllib.parse.urlsplit(config()['DATABASE_URL'])._replace(path='/' + database))


def psql(database, query):
    assert database in ('postgres', DB, CLONE, BACKDB)
    return run(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', database, '-c', query])


def git(*args):
    return run(['runuser', '-u', 'gps-dev', '--', 'git', '-C', WORK, *args])


def protected():
    files = ['/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api',
             '/home/mmm/projects/gps-tracker-api/.env', '/etc/nginx/sites-available/gps.serial.kr',
             '/etc/nginx/sites-available/dev-gps.serial.kr.conf']
    prod = Path('/home/mmm/gps-tracker-web/dist-root').resolve()
    files.extend([prod / 'index.html', prod / 'version.json'])
    return {'files': {str(p): sha(p) for p in files}, 'prod_web': str(prod),
            'services': run(['systemctl', 'show', 'gps-tracker-api', 'shield-api', 'nginx',
                             'gps-pdf-render.socket', '-pId', '-pMainPID', '-pActiveEnterTimestamp'])}


def checksums(q, version):
    q.execute("SELECT version,encode(checksum,'hex') FROM _sqlx_migrations WHERE success ORDER BY version")
    expected = {int(p.name.split('_')[0]): hashlib.sha384(p.read_bytes()).hexdigest()
                for p in (STAGE / 'sources/gps-tracker-api/migrations').glob('*.sql')
                if int(p.name.split('_')[0]) <= version}
    assert dict(q.fetchall()) == expected and max(expected) == version, 'migration history mismatch'


def core(database, columns=None):
    result = {'columns': {}, 'tables': {}}
    with psycopg2.connect(url(database)) as db:
        db.set_session(readonly=True)
        with db.cursor() as q:
            q.execute("SET TIME ZONE 'UTC'")
            for table in ('users', 'devices', 'location_records'):
                q.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=%s ORDER BY ordinal_position", (table,))
                names = columns[table] if columns else [r[0] for r in q.fetchall()]
                result['columns'][table] = names
                fields = ','.join('"' + name + '"' for name in names)
                q.execute(f"SELECT count(*),md5(coalesce(string_agg(h,'' ORDER BY h),'')) FROM (SELECT md5(row({fields})::text) h FROM {table}) s")
                result['tables'][table] = list(q.fetchone())
    return result


def snapshot(source, target):
    assert source in (DB, BACKDB) and target in (BACKDB, CLONE) and source != target
    assert not psql('postgres', f"SELECT 1 FROM pg_database WHERE datname='{target}'")
    psql('postgres', f'ALTER DATABASE {source} ALLOW_CONNECTIONS false')
    try:
        psql('postgres', f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='{source}'")
        psql('postgres', f'CREATE DATABASE {target} WITH TEMPLATE {source} OWNER {ROLE} ALLOW_CONNECTIONS false')
        psql('postgres', f"ALTER DATABASE {target} SET timescaledb.restoring='on'")
        psql('postgres', f'ALTER DATABASE {target} ALLOW_CONNECTIONS true')
        psql(target, 'SELECT alter_job(job_id,scheduled=>false) FROM timescaledb_information.jobs')
        psql(target, 'SELECT timescaledb_post_restore()')
    finally:
        psql('postgres', f'ALTER DATABASE {source} ALLOW_CONNECTIONS true')


def migrate(database):
    started = time.monotonic()
    with psycopg2.connect(url(database)) as db:
        with db.cursor() as q:
            q.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'")
            checksums(q, 72)
            for p in sorted((STAGE / 'sources/gps-tracker-api/migrations').glob('*.sql')):
                version = int(p.name.split('_')[0])
                if version <= 72:
                    continue
                assert version <= 114
                raw = p.read_bytes(); q.execute(raw.decode())
                q.execute('INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(%s,%s,true,%s,0)',
                          (version, p.stem.split('_', 1)[1].replace('_', ' '), psycopg2.Binary(hashlib.sha384(raw).digest())))
            checksums(q, 114)
    return round(time.monotonic() - started, 3)


def request(path, port=3042, token=None, origin=None):
    root = origin or f'http://127.0.0.1:{port}'
    r = urllib.request.Request(root + '/gps-tracker' + path)
    if token: r.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(r, timeout=25) as s: return s.status, json.load(s)
    except urllib.error.HTTPError as s: return s.code, None


def health(port, release):
    for _ in range(25):
        try:
            status, h = request('/health', port)
            if status == 200 and h['ok'] and h['release'] == release: return h
        except (OSError, ValueError): pass
        time.sleep(1)
    raise RuntimeError('health not ready')


def token(uid, secret):
    def enc(v): return base64.urlsafe_b64encode(json.dumps(v).encode()).decode().rstrip('=')
    now = int(time.time())
    body = enc({'alg': 'HS256', 'typ': 'JWT'}) + '.' + enc({'sub': str(uid), 'iat': now, 'exp': now + 300, 'typ': 'access'})
    return body + '.' + base64.urlsafe_b64encode(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()).decode().rstrip('=')


def smoke(database, secret, port=3042, origin=None):
    with psycopg2.connect(url(database)) as db:
        with db.cursor() as q:
            q.execute("SELECT id FROM users WHERE email IN ('user@user.com','user@user4.com') ORDER BY id")
            users = [r[0] for r in q.fetchall()]
    assert users, 'existing test account required'
    results = []
    for uid in users:
        access = token(uid, secret)
        for path in ['/auth/me', '/auth/me/prefs', '/devices', '/privacy/requests/page', '/privacy/collection',
                     '/privacy/processing', '/privacy/subject-mappings', '/privacy/provision-notices',
                     '/corporate/subject-bindings?limit=1']:
            status, _ = request('/api/v1' + path, port, access, origin)
            assert status == 200, (path, status)
            results.append({'path': path, 'status': status})
    status, _ = request('/api/v1/devices', port, origin=origin)
    assert status == 401
    return {'accounts_checked': len(users), 'authenticated_checks': results, 'anonymous': status}


def prepare():
    config(); assert not (BACKUP / 'baseline.json').exists() and not (DEST / 'web').exists()
    assert sha(API) == OLD_API and git('rev-parse', 'HEAD') == OLD_SOURCE and not git('status', '--porcelain')
    assert sha(STAGE / 'source.bundle') == '054b30fd7245aae502747af15b924c1ad35ac13853395937c2dc46a6270269b4'
    assert sha(STAGE / 'migrations.tar') == '604085a3e782cf6b206e919d0b8df5adc9bcfbea4b1018650d56a53fa026f937'
    assert shutil.disk_usage('/').free > 3 * 1024**3
    BACKUP.mkdir(mode=0o700, exist_ok=True); DEST.mkdir(mode=0o755, exist_ok=True)
    DEST.chmod(0o755)
    shutil.copy2(API, BACKUP / 'api.previous'); shutil.copy2(ENV, BACKUP / 'env.previous')
    shutil.copy2(STAGE / 'source.bundle', DEST / 'source.bundle')
    shutil.chown(DEST / 'source.bundle', user='gps-dev', group='gps-dev')
    (DEST / 'source.bundle').chmod(0o644)
    git('bundle', 'verify', DEST / 'source.bundle'); git('fetch', DEST / 'source.bundle', 'HEAD')
    assert git('rev-parse', 'FETCH_HEAD') == SOURCE
    git('merge-base', '--is-ancestor', OLD_SOURCE, SOURCE)
    sources = STAGE / 'sources'; sources.mkdir()
    with tarfile.open(STAGE / 'migrations.tar') as t:
        for m in t.getmembers():
            assert (sources / m.name).resolve().is_relative_to(sources) and (m.isdir() or m.isfile())
        t.extractall(sources)
    with psycopg2.connect(url()) as db:
        with db.cursor() as q: checksums(q, 72)
    artifact = Path('/home/mmm/gps-artifacts/review137-20261116-r1')
    assert sha(artifact / 'gps-tracker-api-r3') == NEW_API
    shutil.copy2(artifact / 'gps-tracker-api-r3', DEST / 'gps-tracker-api-dev')
    assert sha(artifact / 'web-root.tar.gz') == '9a851063d61d72601404a25fa373d9ed028063b901b465335037bb13f14cfeeb'
    web = DEST / 'web'; web.mkdir()
    with tarfile.open(artifact / 'web-root.tar.gz') as t:
        for m in t.getmembers():
            assert (web / m.name).resolve().is_relative_to(web) and (m.isdir() or m.isfile())
        t.extractall(web)
    assert '/gps-tracker/app/' not in (web / 'index.html').read_text()
    files = {str(p.relative_to(web)): sha(p) for p in web.rglob('*') if p.is_file()}
    for p in (WEB / 'assets').iterdir():
        if p.is_file() and not (web / 'assets' / p.name).exists(): shutil.copy2(p, web / 'assets' / p.name)
    (web / 'uploads').symlink_to(HOME / 'uploads')
    (web / 'version.json').write_text(json.dumps({'release': RELEASE, 'api_release': API_RELEASE, 'source_commit': SOURCE, 'schema': 114, 'target': 'dev', 'vite_base': '/', 'feature_activation': False}))
    for p in [DEST, *DEST.rglob('*')]:
        if not p.is_symlink(): p.chmod(0o755 if p.is_dir() or p.name == 'gps-tracker-api-dev' else 0o644)
    run(['chown', '-R', 'gps-dev:gps-dev', DEST])
    baseline = {'production': protected(), 'web': str(WEB.resolve()), 'source': OLD_SOURCE,
                'branch': git('branch', '--show-current'), 'files': files, 'env': sha(ENV)}
    (BACKUP / 'baseline.json').write_text(json.dumps(baseline, indent=2))
    save('prepared', {'passed': True, 'schema_before': 72, 'schema_target': 114, 'source': SOURCE,
                      'dev_data': core(DB)['tables'], 'production': baseline['production']})


def rehearse():
    baseline = json.loads((BACKUP / 'baseline.json').read_text())
    assert protected() == baseline['production'] and sha(API) == OLD_API
    assert not run(['ss', '-H', '-ltn', 'sport = :3042'])
    run(['systemctl', 'stop', 'gps-tracker-api-dev'])
    try: snapshot(DB, BACKDB)
    finally: run(['systemctl', 'start', 'gps-tracker-api-dev'])
    snapshot(BACKDB, CLONE)
    before = core(CLONE); seconds = migrate(CLONE)
    assert core(CLONE, before['columns']) == before
    scratch = HOME / 'align138-scratch'; scratch.mkdir(mode=0o700)
    shutil.chown(scratch, user='gps-dev', group='gps-dev')
    key = secrets.token_hex(32)
    e = {'DATABASE_URL': url(CLONE), 'JWT_SECRET': key, 'APP_ENV': 'test', 'BIND_ADDR': '127.0.0.1:3042',
         'SMS_DEV_MODE': '1', 'UPLOAD_DIR': str(scratch), 'PRIVATE_UPLOAD_DIR': str(scratch),
         'RUST_LOG': 'warn', **{k: 'off' for k in OFF}}
    envfile = BACKUP / 'rehearsal.env'; envfile.write_text('\n'.join(k + '=' + v for k, v in e.items()) + '\n')
    run(['systemd-run', '--collect', '--unit=' + UNIT, '-pUser=gps-dev', '-pGroup=gps-dev',
         '-pEnvironmentFile=' + str(envfile), '-pWorkingDirectory=' + str(scratch),
         '-pIPAddressDeny=any', '-pIPAddressAllow=localhost', '-pNoNewPrivileges=true',
         '-pProtectSystem=strict', '-pReadWritePaths=' + str(scratch), '-pPrivateTmp=true',
         '-pMemoryMax=350M', '-pCPUQuota=50%', DEST / 'gps-tracker-api-dev'])
    try:
        h = health(3042, API_RELEASE); checks = smoke(CLONE, key)
    finally:
        run(['systemctl', 'stop', UNIT]); envfile.unlink(missing_ok=True)
    assert protected() == baseline['production']
    save('rehearsal', {'passed': True, 'script_sha256': sha(__file__), 'migration_seconds': seconds,
                       'core_rows_unchanged': True, 'backup_clone_verified': True, 'health': h, **checks,
                       'production_unchanged': True, 'external_credentials': 'absent', 'load_test_added': False})


def apply():
    r = json.loads((STAGE / 'rehearsal.json').read_text()); baseline = json.loads((BACKUP / 'baseline.json').read_text())
    assert r['passed'] and r['script_sha256'] == sha(__file__)
    assert protected() == baseline['production'] and sha(API) == OLD_API
    config(); assert not git('status', '--porcelain') and git('rev-parse', 'HEAD') == OLD_SOURCE
    assert core(DB) == core(BACKDB), 'dev core data changed since backup; refresh backup before applying'
    nextapi = API.with_name(API.name + '.align138'); shutil.copy2(DEST / 'gps-tracker-api-dev', nextapi)
    shutil.chown(nextapi, user='gps-dev', group='gps-dev'); nextapi.chmod(0o755)
    started = time.monotonic(); committed = False
    run(['systemctl', 'stop', 'gps-tracker-api-dev'])
    try:
        before = core(DB); seconds = migrate(DB); committed = True
        assert core(DB, before['columns']) == before
        os.replace(nextapi, API)
        run(['systemctl', 'start', 'gps-tracker-api-dev']); h = health(3041, API_RELEASE)
        assert h['environment'] == 'development'
        checks = smoke(DB, config()['JWT_SECRET'], 3041)
        link = WEB.with_name('dist.align138'); assert not link.exists() and not link.is_symlink()
        link.symlink_to(DEST / 'web'); os.replace(link, WEB)
        git('switch', '-c', NEW_BRANCH); git('merge', '--ff-only', SOURCE)
        assert not git('status', '--porcelain') and git('rev-parse', 'HEAD') == SOURCE
        assert protected() == baseline['production']
        save('deployment', {'passed': True, 'schema': 114, 'health': h, 'api_sha256': sha(API),
                            'migration_seconds': seconds, 'cutover_seconds': round(time.monotonic() - started, 3),
                            'core_rows_unchanged': True, 'web': str(WEB.resolve()), 'source_branch': NEW_BRANCH,
                            'production_unchanged': True, 'environment_unchanged': sha(ENV) == OLD_ENV, **checks})
    except Exception:
        if not committed: run(['systemctl', 'start', 'gps-tracker-api-dev'])
        else: save('needs-repair', {'schema_committed': True, 'action': 'forward repair; do not discard dev writes'})
        raise


def verify():
    baseline = json.loads((BACKUP / 'baseline.json').read_text())
    config(); assert protected() == baseline['production'] and sha(API) == NEW_API
    assert WEB.resolve() == DEST / 'web' and not git('status', '--porcelain')
    checks = smoke(DB, config()['JWT_SECRET'], 3041, 'https://dev-gps.serial.kr')
    with psycopg2.connect(url()) as db:
        with db.cursor() as q:
            checksums(q, 114)
            policies = {}
            for table in ('location_storage_policy', 'privacy_retention_policy', 'location_subject_policy'):
                q.execute('SELECT enabled FROM ' + table); policies[table] = q.fetchone()[0]
            assert not any(policies.values())
    for name, digest in baseline['files'].items():
        with urllib.request.urlopen('https://dev-gps.serial.kr/' + name, timeout=20) as resp:
            assert hashlib.sha256(resp.read()).hexdigest() == digest, name
            if name.endswith('.js'): assert 'javascript' in resp.headers['Content-Type']
    save('verified', {'passed': True, 'health': health(3041, API_RELEASE), 'schema': 114,
                      'web_files_verified': len(baseline['files']), 'policies': policies,
                      'production_unchanged': True, 'dev_data': core(DB)['tables'],
                      'source': git('rev-parse', 'HEAD'), 'disk_free_bytes': shutil.disk_usage('/').free, **checks})


def cleanup():
    assert json.loads((STAGE / 'verified.json').read_text())['passed']
    psql('postgres', f'DROP DATABASE {CLONE} WITH (FORCE)')
    psql('postgres', f'ALTER DATABASE {BACKDB} ALLOW_CONNECTIONS false')
    (DEST / 'source.bundle').unlink(missing_ok=True)
    save('cleanup', {'rehearsal_db_removed': True, 'backup_retained_connections_closed': BACKDB})


if __name__ == '__main__':
    os.umask(0o077)
    assert os.geteuid() == 0 and len(sys.argv) == 2
    assert sys.argv[1] in ('prepare', 'rehearse', 'apply', 'verify', 'cleanup')
    globals()[sys.argv[1]]()
