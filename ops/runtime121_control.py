"""Root-only synthetic fixture controller; work runs in separate native units."""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

ROOT = Path('/opt/gps121')
assert Path('/etc/runtime121-test-only').read_text().strip() == 'synthetic'
DSN = 'postgres://postgres:closure-test-only@127.0.0.1/gps_closure_test'


def secret(path, value):
    p = Path(path)
    p.write_text(value)
    p.chmod(0o600)


def journal(unit):
    invocation=subprocess.check_output(['systemctl','show',unit,'-p','InvocationID','--value'],text=True).strip()
    select=['_SYSTEMD_INVOCATION_ID='+invocation] if invocation else ['-u',unit]
    return subprocess.check_output(['journalctl', *select, '-o', 'cat', '--no-pager', '-n', '80'], text=True)


def drain():
    """Wait for closed synthetic clients to leave server stats; never kill them."""
    import psycopg
    with psycopg.connect(DSN,autocommit=True) as db:
        for _ in range(100):
            count=db.execute("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'").fetchone()[0]
            if not count:
                return
            time.sleep(.1)
    raise RuntimeError('synthetic clients have not drained')


def job(kind, **data):
    import pwd
    user = 'postgres' if kind in ('recovery','checkpoint') else 'root' if kind == 'transition' else 'gps-api'
    uid = pwd.getpwnam(user).pw_uid
    base = Path('/etc/gps121/credentials')
    base.mkdir(exist_ok=True);base.chmod(0o700)
    folder = base/kind
    folder.mkdir(exist_ok=True);os.chown(folder,uid,uid);folder.chmod(0o500)
    request = folder/'job.json'
    secret(request,json.dumps(dict(kind=kind,**data)));os.chown(request,uid,uid)
    if kind in ('cleanup','closure','checkpoint'):
        key = folder/'keyring.json'
        secret(key,Path('/etc/gps121/keyring.json').read_text());os.chown(key,uid,uid)
    result = ROOT/'job-results'/f'{kind}.json'
    result.unlink(missing_ok=True)
    unit = 'gps121-'+kind+'.service'
    subprocess.run(['systemctl', 'reset-failed', unit], check=False, capture_output=True)
    run = subprocess.run(['systemctl', 'start', unit], capture_output=True, text=True)
    if run.returncode:
        raise RuntimeError(journal(unit))
    return json.loads(result.read_text())


def transition(dsn, ring, uploads, private, mode):
    import crypto20b_transition as c
    assert Path(uploads) == ROOT/'test-storage/uploads' and Path(private) == ROOT/'test-storage/private'
    return job('transition', dsn=dsn, ring=ring, mode=mode,
               interrupt_after_db=c.convert_files.__name__ == 'interrupt')


def pg(*args, **kw):
    # Exact adapter for the old reviewed recovery fixture, never general shell.
    args = list(args)
    assert args.pop(0) == 'docker' and args.pop(0) == 'exec'
    if args[0] == '-i':
        args.pop(0)
    assert args.pop(0) == 'native-db'
    command = args.pop(0)
    assert args[:2] == ['-U', 'postgres']
    args = args[2:]
    if command in ('createdb', 'dropdb'):
        template = args[args.index('-T')+1] if '-T' in args else None
        job('recovery', action='create' if command == 'createdb' else 'drop', database=args[-1], template=template)
    elif command in ('pg_restore', 'psql'):
        name = args[args.index('-d')+1]
        if command == 'pg_restore':
            archive = ROOT/'recovery/archive.dump'
            archive.write_bytes(kw['input'])
            import pwd
            os.chown(archive, pwd.getpwnam('postgres').pw_uid, pwd.getpwnam('postgres').pw_gid)
            archive.chmod(0o600)
            job('recovery', action='restore', database=name)
        else:
            query = args[args.index('-c')+1]
            assert query in ('CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();', 'SELECT timescaledb_post_restore();')
            job('recovery', action='pre' if 'pre_restore' in query else 'post', database=name)
    else:
        raise AssertionError(command)


def dump():
    job('recovery', action='dump', database='gps_closure_test')
    return (ROOT/'recovery/archive.dump').read_bytes()


def migrate(name, dsn):
    secret('/etc/gps121/migration.env', '\n'.join([
        'APP_ENV=test', 'GPS_MIGRATE_ONLY=1', 'DATABASE_URL='+dsn,
        'JWT_SECRET=synthetic-cumulative-migration-only']))
    subprocess.run(['systemctl', 'reset-failed', 'gps121-migration'], check=False, capture_output=True)
    p = subprocess.run(['systemctl', 'start', 'gps121-migration'], capture_output=True, text=True)
    (ROOT/'out'/f'{name}.log').write_text(journal('gps121-migration'))
    if p.returncode:
        raise subprocess.CalledProcessError(p.returncode, 'protected migration unit')


def stop_api():
    subprocess.run(['systemctl', 'stop', 'gps121-api'], check=True)


def boot(binary, env=None, should_fail=None):
    stop_api()
    env = env or {}
    link = ROOT/'active-api'
    link.unlink(missing_ok=True)
    link.symlink_to(binary)
    values = dict(APP_ENV='test', DATABASE_URL=env.get('RUNTIME_DSN', DSN),
        JWT_SECRET='synthetic-cumulative-migration-only', BIND_ADDR='127.0.0.1:3043',
        SMS_DEV_MODE='1', GPS_PDF_SOCKET='/run/gps-pdf-render/render.sock', GPS_PDF_RENDERER='/opt/gps-pdf-render',
        GPS_LOCATION_ENCRYPTION=env.get('STORAGE','off'),
        UPLOAD_DIR=str(ROOT/'test-storage/uploads'), PRIVATE_UPLOAD_DIR=str(ROOT/'test-storage/private'))
    values['GPS_LOCATION_ACCESS_LOG'] = env.get('LEDGER', 'off')
    values['GPS_LOCATION_ACCESS_FLUSH_SECONDS'] = '1'
    values['GPS_SUBJECT_PROVISION'] = env.get('SUBJECTS', 'off')
    if env.get('RUNTIME_DSN'):
        values['GPS_DATABASE_MODE'] = 'runtime'
    if values['GPS_LOCATION_ENCRYPTION'] == 'pilot':
        values['GPS_LOCATION_KEYRING_FILE'] = str(ROOT/'api-keyring.json')
        values['GPS_LOCATION_TEMP_TABLESPACE'] = 'gps121_sort'
    secret('/etc/gps121/api.env', '\n'.join(k+'='+v for k,v in values.items()))
    subprocess.run(['systemctl', 'reset-failed', 'gps121-api'], check=False, capture_output=True)
    subprocess.run(['systemctl', 'start', 'gps121-api'], check=True)
    for _ in range(100):
        state = subprocess.check_output(['systemctl','is-active','gps121-api'],text=True) if subprocess.run(['systemctl','is-active','--quiet','gps121-api']).returncode == 0 else 'failed'
        if state.strip() != 'active':
            log = journal('gps121-api')
            if should_fail and should_fail in log:
                return
            raise AssertionError(log[-4000:])
        if not should_fail:
            try:
                with urllib.request.urlopen('http://127.0.0.1:3043/gps-tracker/health',timeout=1) as r:
                    if json.load(r).get('db'):
                        return
            except Exception:
                pass
        time.sleep(.2)
    raise AssertionError('API did not reach expected state')


def start_baseline():
    boot(str(ROOT/'out/gps-tracker-api.baseline99'))


def boot_new(env=None, should_fail=None):
    boot('/opt/gps-tracker-api',env,should_fail)
