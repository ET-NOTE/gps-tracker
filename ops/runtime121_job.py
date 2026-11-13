"""Fixed synthetic rehearsal jobs executed by protected native systemd units.

Not a production operator interface. Root-owned input + internal-only fixture
marker are mandatory. No external messages, arbitrary shell or remote DSNs.
"""
import json
import errno
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path('/opt/gps121')
assert Path('/etc/runtime121-test-only').read_text().strip() == 'synthetic'
credential = Path(os.environ['CREDENTIALS_DIRECTORY'])/'job.json'
cfg = json.loads(credential.read_text())
kind = sys.argv[1]
assert kind in ('transition', 'cleanup', 'closure', 'recovery', 'checkpoint')
assert cfg['kind'] == kind

# The privileged fixture supplies one read-only credential directory per unit.
# Do not print its contents or silently accept a writable/misbound directory.
try:
    fd = os.open(credential, os.O_WRONLY)
except OSError as exc:
    assert exc.errno == errno.EROFS, 'credential binding is not read-only'
else:
    os.close(fd)
    raise AssertionError('writable unit credential')
if os.geteuid() != 0:
    try:
        list(Path('/etc/gps121/credentials').iterdir())
    except PermissionError:
        pass
    else:
        raise AssertionError('runtime user can traverse private credential sources')
(ROOT/'job-results'/f'{kind}-protection.json').write_text(json.dumps({
    'unit_credential_read_only': True, 'uid': os.geteuid(),
    'source_traversal_denied': os.geteuid() != 0,
    'root_transition_exception': os.geteuid() == 0,
}))


def local(dsn):
    from urllib.parse import urlsplit
    u = urlsplit(dsn)
    assert u.hostname == '127.0.0.1' and u.path.startswith('/gps_')
    return dsn


if kind == 'transition':
    import crypto20b_transition as c
    if cfg.get('interrupt_after_db'):
        original = c.convert_files
        def interrupted(db, uploads, private, ring, apply=False):
            if apply:
                raise RuntimeError('synthetic interruption after DB checkpoint')
            return original(db, uploads, private, ring, apply)
        c.convert_files = interrupted
    assert cfg['mode'] in ('check', 'fence', 'convert', 'resume')
    result = c.run(local(cfg['dsn']), cfg['ring'], str(ROOT/'test-storage/uploads'),
                   str(ROOT/'test-storage/private'), cfg['mode'])
elif kind in ('cleanup', 'closure'):
    from privacy_worker_db import connect
    from privacy_file_cleanup import process_one
    from privacy_account_closure import PENDING, execute
    # Key material only lives in the private unit credential directory.
    worker = dict(cfg['worker'], DATABASE_URL=local(cfg['worker']['DATABASE_URL']),
                  GPS_LOCATION_KEYRING_FILE=str(Path(os.environ['CREDENTIALS_DIRECTORY'])/'keyring.json'))
    with connect(worker) as db:
        if kind == 'cleanup':
            result = {'processed': process_one(db, worker)}
        else:
            with db.cursor() as q:
                q.execute(PENDING)
                ids = [row[0] for row in q.fetchall()]
            result = {'processed': [execute(db, rid) for rid in ids]}
elif kind == 'checkpoint':
    from privacy_restore_checkpoint import export, restore
    worker = dict(cfg['worker'],DATABASE_URL=local(cfg['worker']['DATABASE_URL']),
                  GPS_LOCATION_KEYRING_FILE=str(Path(os.environ['CREDENTIALS_DIRECTORY'])/'keyring.json'))
    path = ROOT/'recovery/checkpoint.json'
    assert cfg['action'] in ('export','restore')
    result = export(worker,path) if cfg['action']=='export' else restore(worker,path,cfg['sha256'])
else:
    action = cfg['action']
    allowed = {'gps_closure_test', 'gps_cumulative_faults', 'gps_cumulative_direct',
               'gps_cumulative_restore', 'gps_cumulative_stale'}
    name = cfg['database']
    assert name in allowed
    common = ['-U', 'postgres']
    archive = ROOT/'recovery/archive.dump'
    if action == 'dump':
        with archive.open('wb') as f:
            subprocess.run(['pg_dump', *common, '-d', name, '-Fc'], stdout=f, check=True)
        archive.chmod(0o600)
        result = {'bytes': archive.stat().st_size}
    elif action == 'restore':
        with archive.open('rb') as f:
            subprocess.run(['pg_restore', *common, '-d', name, '--exit-on-error'], stdin=f, check=True)
        result = {'restored': True}
    elif action == 'create':
        extra = []
        if cfg.get('template'):
            assert cfg['template'] in allowed
            extra = ['-T', cfg['template']]
        subprocess.run(['createdb', *common, *extra, name], check=True)
        result = {'created': True}
    elif action == 'drop':
        assert name != 'gps_closure_test'
        subprocess.run(['dropdb', *common, '--force', name], check=True)
        result = {'dropped': True}
    elif action in ('pre', 'post'):
        query = ('CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();'
                 if action == 'pre' else 'SELECT timescaledb_post_restore();')
        subprocess.run(['psql', *common, '-d', name, '-v', 'ON_ERROR_STOP=1', '-c', query], check=True)
        result = {'restore_phase': action}
    else:
        raise ValueError('unknown fixed recovery action')
(ROOT/'job-results'/f'{kind}.json').write_text(json.dumps(result))
print(json.dumps({'kind': kind, 'completed': True}), flush=True)
