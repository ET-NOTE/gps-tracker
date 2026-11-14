"""Destructive fault injection ONLY in runtime117's disposable synthetic DB."""
import os
from urllib.parse import quote
import json
import subprocess
import time

import psycopg2
import runtime117 as test

b = test.workload()
assert (b.JOB/'protected.enabled').exists()
assert b.info('network', b.NET)['Internal']
assert b.info('volume', b.VOL)['Labels']['gps.runtime117'] == 'synthetic'
data = b.fixture(); did = data['devices'][0]['device_id']; uid = data['users'][0]
path = b.routes(did)[2][1]
client = b.Client()
results = []


def get():
    status, body, _, elapsed = b.Client().get(path, uid)
    return status, body, elapsed


def record(name, status, **kwargs):
    results.append({'case':name, 'passed':status, **kwargs})
    b.save('faults-progress', results)
    assert status, name
    print(name, 'PASS', flush=True)


def ready():
    for _ in range(10):
        code, body, elapsed = get()
        if code == 200: return
        time.sleep(1)
    raise AssertionError('readiness after fault')


# Production startup must not silently accept an unconfigured temporary path.
secret = json.loads((b.JOB/'test-runtime.json').read_text())
trial = subprocess.run(['docker','run','--rm','--network',b.NET,'--memory=550m','--memory-swap=550m',
    '--ulimit=core=0','--cap-drop=ALL','--security-opt=no-new-privileges','--user',f'{os.getuid()}:{os.getgid()}',
    '-v',f'{b.OUT}/gps-tracker-api:/api:ro','-v',f'{b.JOB}/test-keys.json:/keys.json:ro',
    '-e','APP_ENV=production','-e','GPS_DATABASE_MODE=runtime','-e','JWT_SECRET='+b.JWT,
    '-e','DATABASE_URL=postgres://gps_runtime:'+quote(secret['password'])+'@runtime117-db/gps_runtime117_test',
    '-e','GPS_LOCATION_ENCRYPTION=pilot','-e','GPS_LOCATION_KEYRING_FILE=/keys.json',b.IMAGE,'/api'],
    capture_output=True,timeout=20)
record('encrypted_production_requires_temp_setting',trial.returncode!=0 and b'encrypted production requires GPS_LOCATION_TEMP_TABLESPACE' in trial.stderr+trial.stdout)
ready()
before = b.sql('SELECT count(*) FROM location_access_events')[0][0]
b.sql('REVOKE CREATE ON TABLESPACE gps_runtime117_temp FROM gps_runtime')
try:
    code, body, elapsed = get()
    after = b.sql('SELECT count(*) FROM location_access_events')[0][0]
    record('revoked_tablespace_blocks_reused_pool', code != 200 and b'"lat"' not in body and before == after,
           http=code, seconds=elapsed, new_events=after-before)
finally:
    b.sql('GRANT CREATE ON TABLESPACE gps_runtime117_temp TO gps_runtime')
ready()
b.sql('ALTER TABLESPACE gps_runtime117_temp RENAME TO gps_runtime117_hidden')
try:
    code, body, elapsed = get()
    record('missing_tablespace_blocks_existing_pool', code != 200 and b'"lat"' not in body, http=code, seconds=elapsed)
finally:
    b.sql('ALTER TABLESPACE gps_runtime117_hidden RENAME TO gps_runtime117_temp')
ready()

# Lock exactly the synthetic owner's ledger preparation lock. No response data
# may be served when its durable intent cannot be created within the deadline.
lock = b.connect(); lock.autocommit = False
with lock.cursor() as c: c.execute('SELECT pg_advisory_xact_lock(1830,%s)',(uid,))
try:
    code, body, elapsed = get()
    record('prepare_lock_timeout_fail_closed', code == 503 and b'"lat"' not in body and elapsed < 10,
           http=code, seconds=elapsed)
finally:
    lock.rollback(); lock.close()
ready()

# Stall only UPDATE of a synthetic access event (finish), not INSERT (begin).
b.sql("CREATE FUNCTION runtime117_delay_finish() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(7); RETURN NEW; END$$")
b.sql('CREATE TRIGGER runtime117_delay_finish BEFORE UPDATE ON location_access_events FOR EACH ROW EXECUTE FUNCTION runtime117_delay_finish()')
before = b.sql("SELECT count(*) FROM location_access_events WHERE outcome='response_ready'")[0][0]
try:
    code, body, elapsed = get()
    after = b.sql("SELECT count(*) FROM location_access_events WHERE outcome='response_ready'")[0][0]
    record('finish_timeout_fail_closed', code == 503 and b'"lat"' not in body and elapsed < 10 and before == after,
           http=code, seconds=elapsed, completed_delta=after-before)
finally:
    b.sql('DROP TRIGGER runtime117_delay_finish ON location_access_events')
    b.sql('DROP FUNCTION runtime117_delay_finish()')
ready()

secret = json.loads((b.JOB/'test-runtime.json').read_text())
db = psycopg2.connect(host=b.ip(b.DB), user='gps_runtime', password=secret['password'], dbname='gps_runtime117_test')
db.autocommit = True
sort = "SELECT count(*) FROM (SELECT repeat('RUNTIME117_SYNTHETIC_CANARY_',40)||i AS payload FROM generate_series(1,%s) i ORDER BY payload) s"
with db.cursor() as c:
    c.execute("SET work_mem='64kB'; SET statement_timeout='20s'; SET max_parallel_workers_per_gather=0; SET jit=off")
    c.execute('SHOW temp_tablespaces'); record('runtime_tablespace',c.fetchone()[0]=='gps_runtime117_temp')
    c.execute('EXPLAIN (ANALYZE, FORMAT JSON) '+sort,(12000,))
    plan = c.fetchone()[0]
    b.save('protected-sort-plan',plan)
    record('external_sort_uses_disk_spill', 'external merge' in json.dumps(plan))
    c.execute(sort,(12000,)); record('spill_success',c.fetchone()[0]==12000)
    try:
        c.execute(sort,(180000,))
        raise AssertionError('expected temp-file-limit failure')
    except psycopg2.Error as e:
        record('per_process_temp_limit',e.pgcode=='53400',sqlstate=e.pgcode)
    b.run('docker','exec',b.DB,'sh','-c','dd if=/dev/zero of=/gps-temp/full bs=1M count=255 status=none',stdout=subprocess.DEVNULL)
    try:
        try:
            c.execute(sort,(12000,))
            raise AssertionError('expected full tmpfs failure')
        except psycopg2.Error as e:
            record('full_tmpfs_no_disk_fallback',e.pgcode=='53100',sqlstate=e.pgcode)
    finally:
        b.run('docker','exec',b.DB,'rm','/gps-temp/full')
    c.execute(sort,(12000,)); record('spill_recovery',c.fetchone()[0]==12000)
    b.run('docker','exec',b.DB,'mv','/gps-temp/work','/gps-temp/hidden')
    try:
        # It succeeds by design through PostgreSQL's fallback. That fallback
        # MUST be a second protected mount, not the ordinary data volume.
        mounts = subprocess.check_output(['docker','exec',b.DB,'cat','/proc/mounts'],text=True)
        record('fallback_mount_is_tmpfs',any(x.split()[1:3] == ['/var/lib/postgresql/data/base/pgsql_tmp','tmpfs'] for x in mounts.splitlines()))
        c.execute(sort,(12000,)); record('missing_directory_uses_protected_fallback',c.fetchone()[0]==12000)
        b.run('docker','exec',b.DB,'sh','-c','dd if=/dev/zero of=/var/lib/postgresql/data/base/pgsql_tmp/full bs=1M count=63 status=none',stdout=subprocess.DEVNULL)
        try:
            c.execute(sort,(12000,))
            raise AssertionError('expected full fallback failure')
        except psycopg2.Error as e:
            record('full_fallback_no_ordinary_disk',e.pgcode=='53100',sqlstate=e.pgcode)
        finally:
            b.run('docker','exec',b.DB,'rm','/var/lib/postgresql/data/base/pgsql_tmp/full')
    finally:
        b.run('docker','exec',b.DB,'mv','/gps-temp/hidden','/gps-temp/work')
    c.execute(sort,(12000,)); record('directory_restored',c.fetchone()[0]==12000)
db.close(); ready()

for name in [b.DB,b.API]:
    cg = subprocess.check_output(['docker','exec',name,'cat','/sys/fs/cgroup/memory.swap.current'],text=True).strip()
    record(name+'_no_swap',cg=='0',bytes=int(cg))
test.capture(b,'faults')
log=(b.OUT/'faults-timing.log').read_text()
record('prepare_error_phase_observed',any('phase="account_lock"' in x and 'error_or_cancelled' in x for x in log.splitlines()))
record('finish_error_phase_observed',any('phase="event_complete"' in x and 'error_or_cancelled' in x for x in log.splitlines()))
record('diagnostics_exclude_identity_coordinates', all(k not in log for k in ['device_id','account_id','password','SELECT ','127.654321','37.123456']))
b.save('faults',{'cases':results,'all_passed':all(x['passed'] for x in results),'production_modified':False})
