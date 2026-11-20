"""99 -> 113 rehearsal on an internal network and disposable native PostgreSQL unit.

No production address, credentials, snapshot or deployment action is accepted.
Run from a prepared build-host job; see the runtime121 operations document.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import time
import urllib.request

import psycopg
from psycopg import sql
from admin_db_roles import run as separate_roles
from crypto20b_transition import run as transition, convert_files, connect
from location_storage import create_keyring, run as scan
from privacy_worker_db import connect as worker_connect

HERE = pathlib.Path(__file__).resolve().parent
assert HERE == pathlib.Path('/opt/gps121')
NET = 'gps-provision22-test-20261113cumulative119'
DB = 'native-db'
API = 'gps-provision22-api-20261113cumulative119'
NAME = 'gps_closure_test'
IMAGE = 'gps-build:rust1.88-node22.22.2'
BASE_SHA = 'fa1e51e3d39473ca2852ac6b2899790547fa6667bb7337c646d29258a3e1c0fe'
API_SHA = '89293eb52d7c07229e7fdfa594a63aa61282abe14ed1bf5d0a66d21fb3e15bc8'
BASE = HERE / 'out/gps-tracker-api.baseline99'
NEW = HERE / 'out/gps-tracker-api'
assert hashlib.sha256(BASE.read_bytes()).hexdigest() == BASE_SHA
assert hashlib.sha256(NEW.read_bytes()).hexdigest() == API_SHA
BASE.chmod(0o755)
OUT = HERE / 'out'
REPORT = {'environment': 'isolated synthetic; not production evidence', 'production_modified': False,
          'baseline_sha256': BASE_SHA, 'candidate_sha256': API_SHA, 'schema_path': [99, 113],
          'external_messages': 0, 'checks': [], 'timings': {}}


def cmd(*args, **kw):
    return subprocess.run(list(args), check=True, **kw)


def inspect(kind, name):
    return json.loads(subprocess.check_output(['docker', kind, 'inspect', name]))[0]


def record(name, **extra):
    REPORT['checks'].append({'check': name, **extra})
    (OUT / 'cumulative121.json').write_text(json.dumps(REPORT, indent=2))
    print('PASS ' + name, flush=True)




def connection(dsn=None, ring=None):
    db = psycopg.connect(dsn or DSN, autocommit=True)
    db.execute("SET statement_timeout='60s'; SET lock_timeout='5s'; SET jit=off; SET temp_tablespaces='gps121_sort'")
    if ring:
        db.execute("SELECT set_config('gps.storage_keys',%s,false)", (json.dumps(ring),))
    return db








def identities(db):
    return db.execute("SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u),(SELECT jsonb_agg(to_jsonb(d)-ARRAY(SELECT key FROM jsonb_each(to_jsonb(d)) WHERE key LIKE '%_sealed') ORDER BY id) FROM devices d),(SELECT jsonb_agg(to_jsonb(c) ORDER BY device_id) FROM device_data_controls c),(SELECT jsonb_agg(to_jsonb(c) ORDER BY user_id) FROM privacy_account_controls c))::text)").fetchone()[0]


def locations(db, view='location_records'):
    return db.execute(sql.SQL("SELECT count(*),md5(string_agg(md5(jsonb_build_array(device_id,user_id,recorded_at,lat,lng,fixes_jsonb)::text),'' ORDER BY device_id,recorded_at)) FROM {}").format(sql.Identifier(view))).fetchone()


def check_off(db):
    assert db.execute('SELECT enabled OR maintenance FROM location_storage_policy').fetchone() == (False,)
    assert db.execute('SELECT enabled FROM privacy_retention_policy').fetchone() == (False,)
    assert db.execute('SELECT enabled OR push_enabled FROM location_subject_policy').fetchone() == (False,)
    for table in ('location_subject_mappings', 'privacy_retention_consents', 'location_access_events', 'location_access_log', 'admin_principals'):
        assert db.execute(sql.SQL('SELECT count(*) FROM {}').format(sql.Identifier(table))).fetchone() == (0,)


def failure(call, contains):
    try:
        call()
    except Exception as e:
        assert contains in str(e), type(e).__name__
    else:
        raise AssertionError('expected rejection: ' + contains)




from runtime121_control import DSN, start_baseline, stop_api, boot_new, migrate, transition, pg as quiet, dump, job, secret, drain

start_baseline()
stop_api()

with connection() as db:
    assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone() == (99,)
    for version, checksum in db.execute('SELECT version,checksum FROM _sqlx_migrations'):
        f = next((HERE / 'src/gps-tracker-api/migrations').glob(f'{version:04}_*.sql'))
        assert hashlib.sha384(f.read_bytes()).digest() == bytes(checksum)
    uid = db.execute("INSERT INTO users(phone,email,password_hash,display_name) VALUES('synthetic108','113@example.invalid','no-login','Synthetic only') RETURNING id").fetchone()[0]
    did = db.execute("INSERT INTO devices(owner_id,device_uid,iccid,api_key_hash,last_lat,last_lng,last_fix_at) VALUES(%s,'cumulative119-sim','8988000000000000108','',37.1,127.1,now()) RETURNING id", (uid,)).fetchone()[0]
    # Exceeds the observed production row count and expanded point count, not a copy of its distribution.
    db.execute("""INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,fixes_jsonb)
      SELECT %s,%s,'2026-10-01'::timestamptz+i*interval '10 seconds','l80',true,37.1,127.1,
      CASE WHEN i<=17000 THEN (SELECT jsonb_agg(jsonb_build_object('at_ms',j*1000,'lat',37.1+j*0.00001,'lng',127.1+j*0.00001,'up_ms',i*30000+j*1000)) FROM generate_series(-29,0) j) END
      FROM generate_series(1,130000) i""", (did, uid))
    db.execute("INSERT INTO geofences(owner_id,user_id,name,center_lat,center_lng,radius_m) VALUES(%s,%s,'Synthetic',37.1,127.1,100)", (uid, uid))
    before_id, before_location = identities(db), locations(db)
    REPORT['synthetic'] = {'rows': 130000, 'batched_rows': 17000, 'expanded_points': 623000}
    REPORT['database_bytes_before'] = db.execute('SELECT pg_database_size(current_database())').fetchone()[0]
record('actual schema99 binary and historical migration checksums; synthetic workload seeded')

# Exercise each additive migration's transaction failure, keeping earlier commits.
# This is an isolated scratch database, not a production down-migration procedure.
quiet('docker', 'exec', DB, 'createdb', '-U', 'postgres', '-T', NAME, 'gps_cumulative_faults')
fault = DSN.rsplit('/', 1)[0] + '/gps_cumulative_faults'
failed_versions = []
with connection(fault) as db:
    for version in range(100, 114):
        migration = next((HERE / 'src/gps-tracker-api/migrations').glob(f'{version:04}_*.sql'))
        before = db.execute("SELECT md5(string_agg(c.relname||':'||a.attname||':'||a.atttypid::text,',' ORDER BY c.relname,a.attnum)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped").fetchone()[0]
        before_functions = db.execute("SELECT md5(string_agg(pg_get_functiondef(p.oid),'' ORDER BY p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'").fetchone()[0]
        try:
            with db.transaction():
                db.execute(migration.read_text())
                db.execute('SELECT 1/0')
        except psycopg.errors.DivisionByZero:
            pass
        assert db.execute("SELECT md5(string_agg(c.relname||':'||a.attname||':'||a.atttypid::text,',' ORDER BY c.relname,a.attnum)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped").fetchone()[0] == before
        assert db.execute("SELECT md5(string_agg(pg_get_functiondef(p.oid),'' ORDER BY p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'").fetchone()[0] == before_functions
        assert identities(db) == before_id and locations(db) == before_location
        with db.transaction():
            db.execute(migration.read_text())
            db.execute("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(%s,%s,true,%s,0)",
                       (version, migration.stem.split('_', 1)[1].replace('_', ' '), hashlib.sha384(migration.read_bytes()).digest()))
        failed_versions.append(version)
migrate('resume-after-per-migration-interruptions', fault)
quiet('docker', 'exec', DB, 'dropdb', '-U', 'postgres', '--force', 'gps_cumulative_faults')
record('all fourteen migration transactions roll back on injected failure; committed prefixes resume with real candidate', versions=failed_versions)

# Match the non-superuser table-owner migration boundary observed on production.
with connection() as db:
    db.execute("CREATE ROLE gps_migration LOGIN PASSWORD 'synthetic-migration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE")
    db.execute('GRANT USAGE,CREATE ON SCHEMA public TO gps_migration')
    for table, kind in db.execute("SELECT c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e') ORDER BY c.relkind,c.relname").fetchall():
        typ = {'v': 'VIEW', 'm': 'MATERIALIZED VIEW'}.get(kind, 'TABLE')
        db.execute(sql.SQL('ALTER ' + typ + ' {} OWNER TO gps_migration').format(sql.Identifier('public', table)))
    for (routine,) in db.execute("SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')").fetchall():
        db.execute(sql.SQL('ALTER FUNCTION {} OWNER TO gps_migration').format(sql.SQL(routine)))
quiet('docker', 'exec', DB, 'createdb', '-U', 'postgres', '-T', NAME, 'gps_cumulative_direct')
try:
    migrate('missing-extension-rejected', DSN.replace('postgres:closure-test-only', 'gps_migration:synthetic-migration-only'))
except subprocess.CalledProcessError:
    assert 'permission denied to create extension "pgcrypto"' in (OUT / 'missing-extension-rejected.log').read_text()
else:
    raise AssertionError('non-privileged role unexpectedly installed extension')
with connection() as db:
    assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone() == (102,)
    assert locations(db) == before_location
    # Extension provisioning is a separate DB administrator operation. Do not
    # give the API/migration role CREATE DATABASE or superuser capabilities.
    db.execute('CREATE EXTENSION pgcrypto WITH SCHEMA public')
migrate('resume102-to113-nonsuperuser', DSN.replace('postgres:closure-test-only', 'gps_migration:synthetic-migration-only'))
record('missing pgcrypto stops at102 without corrupting data; DB administrator provisions extension and restricted migration resumes')
direct = DSN.rsplit('/', 1)[0] + '/gps_cumulative_direct'
with connection(direct) as db:
    db.execute('CREATE EXTENSION pgcrypto WITH SCHEMA public')
migrate('direct99-to113-nonsuperuser', direct.replace('postgres:closure-test-only', 'gps_migration:synthetic-migration-only'))
with connection(direct) as db:
    assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone() == (113,)
    assert identities(db) == before_id and locations(db) == before_location
    check_off(db)
quiet('docker', 'exec', DB, 'dropdb', '-U', 'postgres', '--force', 'gps_cumulative_direct')
record('prepared restricted owner completes real single-pass99 to113 with original data preserved and defaults OFF')
with connection() as db:
    assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone() == (113,)
    assert identities(db) == before_id and locations(db) == before_location
    check_off(db)
boot_new()
stop_api()
record('99 to113 non-superuser owner migration and OFF API boot; identities, SIM, locations preserved; no consent inferred')

roots = HERE / 'test-storage'
for name in ('uploads/device_documents/1/1', 'uploads/fleet_documents/1/1', 'private/car-images'):
    p = roots / name
    p.mkdir(parents=True, exist_ok=True)
    (p / 'synthetic.bin').write_bytes(os.urandom(512 * 1024))
key = HERE / 'test-keys.json'
create_keyring(key)
ring = json.loads(key.read_text())
secret('/etc/gps121/keyring.json',json.dumps(ring))
secret('/opt/gps121/api-keyring.json',json.dumps(ring))
import pwd
os.chown('/opt/gps121/api-keyring.json',pwd.getpwnam('gps-api').pw_uid,pwd.getpwnam('gps-api').pw_gid)
for p in roots.rglob('*'):
    os.chown(p,pwd.getpwnam('gps-api').pw_uid,pwd.getpwnam('gps-api').pw_gid)
os.chown(roots,pwd.getpwnam('gps-api').pw_uid,pwd.getpwnam('gps-api').pw_gid)
uploads, private = str(roots / 'uploads'), str(roots / 'private')

# A database session is enough to prevent maintenance; no automatic session killing.
with connection() as blocker:
    failure(lambda: transition(DSN, ring, uploads, private, 'fence'), 'stop ALL')
with connection() as db:
    db.execute("ALTER DATABASE gps_closure_test SET log_parameter_max_length=-1")
failure(lambda: transition(DSN, ring, uploads, private, 'check'), 'bind logging')
with connection() as db:
    db.execute("ALTER DATABASE gps_closure_test SET log_parameter_max_length=0")
drain()
failure(lambda: transition(DSN, ring, uploads, private, 'fence'), 'legacy Timescale retention')
with connection() as db:
    legacy = db.execute("SELECT job_id FROM timescaledb_information.jobs WHERE proc_name='policy_retention' AND hypertable_schema='public'").fetchall()
    assert legacy
    for legacy_job_id, in legacy:
        db.execute('SELECT alter_job(%s,scheduled=>false)', (legacy_job_id,))
    for _ in range(60):
        running = db.execute("SELECT count(*) FROM timescaledb_information.job_stats WHERE job_id=ANY(%s) AND job_status='Running'", ([r[0] for r in legacy],)).fetchone()[0]
        if not running:
            break
        time.sleep(1)
    assert not running
REPORT['legacy_retention'] = {'scheduled_job_rejected': True, 'paused_in_disposable_db_only': True}
transition(DSN, ring, uploads, private, 'fence')
failure(lambda: transition(DSN, ring, uploads, private, 'resume'), 'plaintext')
boot_new(should_fail='maintenance')
record('other writers, unsafe bind logging, legacy retention, premature resume and maintenance startup are rejected')

# Commit DB batches, then stop before the first file rewrite. Recovery is forward-only.
import crypto20b_transition as coordinator
original_files = coordinator.convert_files


def interrupt(db, uploads, private, ring, apply=False):
    if apply:
        raise RuntimeError('synthetic interruption after DB checkpoint')
    return original_files(db, uploads, private, ring, apply)


coordinator.convert_files = interrupt
t = time.monotonic()
try:
    failure(lambda: transition(DSN, ring, uploads, private, 'convert'), 'synthetic interruption')
finally:
    coordinator.convert_files = original_files
REPORT['timings']['initial_db_conversion_seconds'] = round(time.monotonic() - t, 3)
with connect(DSN, ring) as db:
    assert db.execute('SELECT maintenance FROM location_storage_policy').fetchone() == (True,)
    assert locations(db, 'gps_read_location_records') == before_location
    original_hashes = convert_files(db, uploads, private, ring)['content_hashes']
failure(lambda: transition(DSN, ring, uploads, private, 'resume'), 'plaintext')
resumed = transition(DSN, ring, uploads, private, 'convert')
assert sum(r['converted'] for r in resumed['database']['tables'].values()) == 0
assert resumed['files']['converted'] == 3 and resumed['ready_to_start_key_configured_api']
again = transition(DSN, ring, uploads, private, 'convert')
assert sum(r['converted'] for r in again['database']['tables'].values()) == 0 and again['files']['converted'] == 0
REPORT['conversion'] = resumed
record('conversion interrupted after DB commits stays fenced; retry only converts files; subsequent retry makes no writes')

separate_roles(DSN, True, str(HERE / 'test-runtime.json'))
with connection() as db:
    db.execute('GRANT CREATE ON TABLESPACE gps121_sort TO gps_runtime')
cred = json.loads((HERE / 'test-runtime.json').read_text())
runtime = DSN.replace('postgres:closure-test-only', cred['user'] + ':' + cred['password'])
cfg = {'DATABASE_URL': runtime, 'GPS_LOCATION_ENCRYPTION': 'pilot', 'GPS_LOCATION_KEYRING_FILE': str(key)}
failure(lambda: worker_connect(cfg), 'maintenance')
with connection(runtime, ring) as db:
    for q in ['ALTER TABLE devices DISABLE TRIGGER ALL', 'UPDATE location_storage_policy SET maintenance=false',
              'DELETE FROM location_notice_attempts', 'UPDATE privacy_retention_policy SET enabled=true',
              'UPDATE users SET display_name=display_name']:
        try:
            db.execute(q)
        except psycopg.Error:
            pass
        else:
            raise AssertionError('runtime bypass: ' + q)
transition(DSN, ring, uploads, private, 'resume')
failure(lambda: worker_connect({**cfg, 'GPS_LOCATION_ENCRYPTION': 'off'}), 'mismatch')
boot_new({'RUNTIME_DSN': runtime, 'STORAGE': 'off'}, should_fail='storage')
boot_new({'RUNTIME_DSN': runtime, 'STORAGE': 'pilot'})
stop_api()
from privacy_scope_inventory import account_scope
from privacy_file_cleanup import process_one
from privacy_account_closure import PENDING
with worker_connect(cfg) as worker:
    account_scope(worker, uid)
with worker_connect(cfg) as worker:
    assert process_one(worker, {**cfg, 'UPLOAD_DIR': uploads, 'PRIVATE_UPLOAD_DIR': private}) is None
with worker_connect(cfg) as worker:
    with worker.cursor() as c:
        c.execute(PENDING)
        assert c.fetchall() == []
job('cleanup',worker={**cfg,'UPLOAD_DIR':uploads,'PRIVATE_UPLOAD_DIR':private})
job('closure',worker=cfg)
record('restricted API and actual cleanup and closure units use same key/mode; policy, DDL and maintenance bypass rejected')

with connection(ring=ring) as db:
    assert locations(db, 'gps_read_location_records') == before_location
    assert db.execute('SELECT bool_and(lat IS NULL AND lng IS NULL AND fixes_jsonb IS NULL) FROM location_records').fetchone() == (True,)
    t = time.monotonic()
    n = db.execute("SELECT count(*) FROM location_history_points_between(%s,%s,'2026-10-01','2026-11-01')", (did, uid)).fetchone()[0]
    # Batches overlap in this fixture: history deduplicates (timestamp,source).
    expected_times = {i * 10 + j for i in range(1, 17001) for j in range(-29, 1)}
    expected_times.update(i * 10 for i in range(17001, 130001))
    expected_history = sum(at >= 0 for at in expected_times)
    assert n == expected_history == 283001, n
    REPORT['synthetic']['deduplicated_history_points'] = n
    REPORT['timings']['history_points_count_seconds'] = round(time.monotonic() - t, 3)
    REPORT['database_bytes_after'] = db.execute('SELECT pg_database_size(current_database())').fetchone()[0]
    REPORT['wal_bytes_since_cluster_start'] = int(db.execute("SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),'0/0')").fetchone()[0])
record('all original location values survive encryption; physical columns NULL; 623000 raw samples yield283001 deduplicated in-range history points')

# Full protected restore: never reopen the old binary or reverse a migration.
transition(DSN, ring, uploads, private, 'fence')
t = time.monotonic()
dump = dump()
REPORT['timings']['full_dump_seconds'] = round(time.monotonic() - t, 3)
REPORT['full_dump_bytes'] = len(dump)
quiet('docker', 'exec', DB, 'createdb', '-U', 'postgres', 'gps_cumulative_restore')
quiet('docker', 'exec', DB, 'psql', '-U', 'postgres', '-d', 'gps_cumulative_restore', '-v', 'ON_ERROR_STOP=1',
      '-c', 'CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();')
t = time.monotonic()
quiet('docker', 'exec', '-i', DB, 'pg_restore', '-U', 'postgres', '-d', 'gps_cumulative_restore', '--exit-on-error', input=dump)
quiet('docker', 'exec', DB, 'psql', '-U', 'postgres', '-d', 'gps_cumulative_restore', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT timescaledb_post_restore();')
REPORT['timings']['full_restore_seconds'] = round(time.monotonic() - t, 3)
restore_dsn = DSN.rsplit('/', 1)[0] + '/gps_cumulative_restore'
with connection(restore_dsn) as db:
    try:
        db.execute('SELECT lat FROM gps_read_location_records LIMIT 1').fetchone()
    except psycopg.Error:
        pass
    else:
        raise AssertionError('restored plaintext readable without key')
with connection(restore_dsn, ring) as db:
    assert db.execute('SELECT maintenance FROM location_storage_policy').fetchone() == (True,)
    assert locations(db, 'gps_read_location_records') == before_location
    restored_files = HERE / 'restored-storage'
    shutil.copytree(roots, restored_files)
    assert convert_files(db, str(restored_files / 'uploads'), str(restored_files / 'private'), ring)['content_hashes'] == original_hashes
record('full Timescale DB plus encrypted files restore while fenced; separately held key required; all location/file hashes equal')
from verify_runtime125_reads import restored
restored(restore_dsn, runtime.rsplit('/',1)[0]+'/gps_cumulative_restore', uid, did, ring)
quiet('docker', 'exec', DB, 'dropdb', '-U', 'postgres', '--force', 'gps_cumulative_restore')
shutil.rmtree(restored_files)
transition(DSN, ring, uploads, private, 'resume')
boot_new({'RUNTIME_DSN': runtime, 'STORAGE': 'pilot'})
REPORT['runtime_ready_for_regressions'] = True
record('cumulative rehearsal complete; isolated encrypted API ready for business/privacy regression')
