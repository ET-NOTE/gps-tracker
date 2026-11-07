"""Actual baseline99 binary -> candidate104 OFF on a new synthetic database.
Never takes a production snapshot or contacts production. Keeps the old data
fingerprint, verifies failed upgrade transaction atomicity and measures conversion.
"""
import hashlib,json,os,pathlib,shutil,subprocess,time,urllib.request
import psycopg
from crypto20b_transition import run as transition
from location_storage import create_keyring
HERE=pathlib.Path(__file__).resolve().parent
assert str(HERE).startswith('/home/etcom-hub/build/gps-crypto20b-')
NET='gps-crypto20b-test-20261105';DB='gps-crypto20b-db-20261105';API='gps-crypto20b-upgrade-api'
inspect=lambda kind,name:json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NET)['Internal']
di=inspect('container',DB);assert '/var/lib/postgresql/data' in di['HostConfig']['Tmpfs']
database='gps_crypto20b_upgrade';dsn='postgres://postgres:closure-test-only@'+di['NetworkSettings']['Networks'][NET]['IPAddress']+'/'+database
baseline=pathlib.Path('/home/etcom-hub/build/gps-ledger18b-20261107/out/gps-tracker-api.baseline99')
copy=HERE/'out/gps-tracker-api.baseline99';shutil.copy2(baseline,copy);copy.chmod(0o755);baseline=copy
assert hashlib.sha256(baseline.read_bytes()).hexdigest()=='fa1e51e3d39473ca2852ac6b2899790547fa6667bb7337c646d29258a3e1c0fe'
def run(*args,**kw):return subprocess.run(list(args),check=True,**kw)
def start(binary):
    run('docker','run','-d','--name',API,'--network',NET,'--memory=550m','--cap-drop=ALL','--security-opt=no-new-privileges',
        '-e','APP_ENV=test','-e','BIND_ADDR=0.0.0.0:3043','-e','DATABASE_URL=postgres://postgres:closure-test-only@closure-db:5432/'+database,
        '-e','JWT_SECRET=closure-test-only-jwt-key-32-characters','-e','SMS_DEV_MODE=1','-v',str(binary)+':/api:ro','gps-build:rust1.88-node22.22.2','/api',stdout=subprocess.DEVNULL)
    ip=inspect('container',API)['NetworkSettings']['Networks'][NET]['IPAddress']
    for _ in range(60):
        try:
            with urllib.request.urlopen('http://'+ip+':3043/gps-tracker/health',timeout=2) as r:
                if json.load(r).get('db'):return
        except Exception:pass
        if not inspect('container',API)['State']['Running']:raise AssertionError('upgrade API exited')
        time.sleep(1)
    raise AssertionError('upgrade API not ready')
def stop():
    run('docker','stop','-t','15',API,stdout=subprocess.DEVNULL)
    run('docker','rm',API,stdout=subprocess.DEVNULL)
    # A removed Docker endpoint can leave PostgreSQL waiting on ClientWrite.
    # Drain only this disposable database after its sole API container is gone.
    assert database=='gps_crypto20b_upgrade' and inspect('network',NET)['Internal']
    with psycopg.connect(dsn,autocommit=True) as drain:
        drain.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")
run('docker','exec',DB,'createdb','-U','postgres',database)
start(baseline);stop()
db=psycopg.connect(dsn,autocommit=True)
def q(s,args=()):return db.execute(s,args).fetchone()[0]
assert q('SELECT max(version) FROM _sqlx_migrations')==99
for version,checksum in db.execute('SELECT version,checksum FROM _sqlx_migrations').fetchall():
    migration=next((HERE/'src/gps-tracker-api/migrations').glob(f'{version:04}_*.sql'))
    assert hashlib.sha384(migration.read_bytes()).digest()==bytes(checksum),('historical checksum mismatch',version)
uid=q("INSERT INTO users(phone,email,password_hash,display_name) VALUES('+821099992020','upgrade20b@example.invalid','not-a-login','Synthetic upgrade') RETURNING id")
did=q("INSERT INTO devices(owner_id,device_uid,iccid,api_key_hash) VALUES(%s,'upgrade20b-sim','8988000000000000099','') RETURNING id",(uid,))
# 5,000 batches / 150,000 synthetic points: bounded benchmark, not a production copy.
db.execute("""INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,fixes_jsonb)
 SELECT %s,%s,'2026-11-01'::timestamptz+i*interval '30 seconds','l80',true,37.1,127.1,
 (SELECT jsonb_agg(jsonb_build_object('at_ms',j*1000,'lat',37.1+j*0.00001,'lng',127.1+j*0.00001,'up_ms',i*30000+j*1000)) FROM generate_series(-29,0) j)
 FROM generate_series(1,5000) i""",(did,uid))
db.execute("INSERT INTO geofences(owner_id,user_id,name,center_lat,center_lng,radius_m) VALUES(%s,%s,'Upgrade fence',37.1,127.1,100)",(uid,uid))
def fingerprint():return q("SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u),(SELECT jsonb_agg(jsonb_build_array(id,device_uid,iccid,owner_id) ORDER BY id) FROM devices),(SELECT count(*) FROM location_records),(SELECT sum(lat) FROM location_records))::text)")
before=fingerprint();size_before=q('SELECT pg_database_size(current_database())')
# Failure inside the additive migration transaction leaves old schema/data intact.
migration=(HERE/'src/gps-tracker-api/migrations/0100_location_access_log.sql')
if not migration.exists():migration=next((HERE/'src/gps-tracker-api/migrations').glob('0100_*.sql'))
try:
    with db.transaction():
        db.execute(migration.read_text());db.execute('SELECT 1/0')
except psycopg.Error:pass
assert q('SELECT max(version) FROM _sqlx_migrations')==99 and fingerprint()==before
assert q("SELECT to_regclass('location_access_log') IS NULL")
started=time.monotonic();start(HERE/'out/gps-tracker-api');upgrade_seconds=time.monotonic()-started
assert q('SELECT max(version) FROM _sqlx_migrations')==104 and fingerprint()==before
assert q('SELECT enabled OR maintenance FROM location_storage_policy') is False
for table in ('location_access_events','location_access_log'):
    assert q('SELECT count(*) FROM '+table)==0
stop();db.close()
roots=HERE/'upgrade-storage'
for name in ('uploads','private'):(roots/name).mkdir(parents=True,exist_ok=True)
keyfile=HERE/'upgrade-keys.json';create_keyring(keyfile);ring=json.loads(keyfile.read_text())
transition(dsn,ring,str(roots/'uploads'),str(roots/'private'),'fence')
started=time.monotonic();result=transition(dsn,ring,str(roots/'uploads'),str(roots/'private'),'convert');conversion_seconds=time.monotonic()-started
assert result['ready_to_start_key_configured_api']
with psycopg.connect(dsn,autocommit=True) as db:
    db.execute("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ring),))
    start_query=time.monotonic()
    n=db.execute("SELECT count(*) FROM location_history_points_between(%s,%s,'2026-11-01','2026-11-04')",(did,uid)).fetchone()[0]
    assert n==150000,n
    query_seconds=time.monotonic()-start_query
    size_after=db.execute('SELECT pg_database_size(current_database())').fetchone()[0]
report={'schema_path':[99,104],'synthetic_batches':5000,'points':n,'baseline_sha256':hashlib.sha256(baseline.read_bytes()).hexdigest(),
        'candidate_sha256':hashlib.sha256((HERE/'out/gps-tracker-api').read_bytes()).hexdigest(),
        'historical_migration_checksums_match':True,'identity_and_plaintext_data_unchanged_in_off_upgrade':True,'failed_migration_atomic':True,'ledger_stays_off':True,
        'upgrade_seconds':round(upgrade_seconds,3),'conversion_seconds':round(conversion_seconds,3),'history_count_seconds':round(query_seconds,3),
        'database_bytes_before':size_before,'database_bytes_after':size_after,'production_scale_rehearsal':False}
(HERE/'out/upgrade.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
