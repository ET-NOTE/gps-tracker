"""Disposable-only: compressed chunks, key rotation, full restore, runtime fence."""
import base64, hashlib, json, os, pathlib, shutil, subprocess, time
import psycopg
from psycopg import sql
from crypto20b_transition import run as transition, connect, convert_files
from location_storage import run as scan
from privacy_worker_db import connect as worker_connect

HERE=pathlib.Path(__file__).resolve().parent
assert str(HERE).startswith('/home/etcom-hub/build/gps-crypto20b-')
NET='gps-crypto20b-test-20261105';DB='gps-crypto20b-db-20261105'
inspect=lambda kind,name:json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NET)['Internal']
di=inspect('container',DB);assert '/var/lib/postgresql/data' in di['HostConfig']['Tmpfs']
dsn='postgres://postgres:closure-test-only@'+di['NetworkSettings']['Networks'][NET]['IPAddress']+'/gps_closure_test'
uploads=str(HERE/'test-storage/uploads');private=str(HERE/'test-storage/private')
keyfile=HERE/'test-keys.json';ring=json.loads(keyfile.read_text());groups=[]
def ok(s):groups.append(s);print('PASS '+s,flush=True)
def command(*args,**kw):return subprocess.run(list(args),check=True,**kw)
def fingerprint(db):
    result={}
    with db.cursor() as c:
        c.execute('SELECT table_name FROM location_storage_fields ORDER BY table_name')
        for (t,) in c.fetchall():
            c.execute(sql.SQL("SELECT count(*),md5(coalesce(string_agg(md5(row_to_json(r)::text),'' ORDER BY md5(row_to_json(r)::text)),'')) FROM {} r").format(sql.Identifier('gps_read_'+t)))
            result[t]=list(c.fetchone())
    return result
command('bash',str(HERE/'dev20b.sh'),'stop')
db=connect(dsn,ring)
with db.cursor() as c:
    c.execute("SELECT compress_chunk(c,if_not_compressed=>true) FROM show_chunks('location_records') c")
    compressed=len(c.fetchall());assert compressed>0
controls_before=db.execute("SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(t) ORDER BY device_id) FROM device_data_controls t),(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM privacy_account_controls t))::text)").fetchone()[0]
before=fingerprint(db);files_before=convert_files(db,uploads,private,ring)
db.close();ok('encrypted location chunks compressed before conversion')
transition(dsn,ring,uploads,private,'fence')
# Startup refuses maintenance, including an API that has the correct key.
r=subprocess.run(['bash',str(HERE/'dev20b.sh'),'api'],env={**os.environ,'STORAGE':'pilot'},capture_output=True,text=True)
assert r.returncode!=0 and 'maintenance' in r.stdout+r.stderr
ok('API startup refuses active maintenance fence')
next_id='v'+str(len(ring['keys'])+1)
ring2={'active':next_id,'keys':{**ring['keys'],next_id:base64.b64encode(os.urandom(32)).decode()}}
# Persist both keys BEFORE the first checkpoint; interruption must not lose the new key.
keyfile.write_text(json.dumps(ring2))
# Fail after committed DB batches and before file replacement; retain both keys.
import crypto20b_transition as coordinator
original_files=coordinator.convert_files
def interrupted_files(db,uploads,private,ring,apply=False):
    if apply:raise RuntimeError('synthetic interruption after DB checkpoints')
    return original_files(db,uploads,private,ring,apply)
coordinator.convert_files=interrupted_files
try:
    try:transition(dsn,ring2,uploads,private,'convert')
    except RuntimeError as e:assert 'synthetic interruption' in str(e)
    else:raise AssertionError('interruption not injected')
finally:coordinator.convert_files=original_files
check=connect(dsn,ring2)
assert check.execute('SELECT maintenance FROM location_storage_policy').fetchone()[0]
assert fingerprint(check)==before
assert convert_files(check,uploads,private,ring2)['content_hashes']==files_before['content_hashes']
check.close();ok('interruption after committed DB batches retains fence and readable files; both keys preserved')
started=time.monotonic();rotation=transition(dsn,ring2,uploads,private,'convert');elapsed=time.monotonic()-started
assert sum(t['converted'] for t in rotation['database']['tables'].values())==0
assert rotation['files']['converted']>0
assert rotation['ready_to_start_key_configured_api']
only={'active':next_id,'keys':{next_id:ring2['keys'][next_id]}}
db=connect(dsn,only);assert fingerprint(db)==before
assert db.execute("SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(t) ORDER BY device_id) FROM device_data_controls t),(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM privacy_account_controls t))::text)").fetchone()[0]==controls_before
assert convert_files(db,uploads,private,only)['content_hashes']==files_before['content_hashes'];db.close()
keyfile.write_text(json.dumps(only))
assert all(x['plaintext_rows']==0 for x in scan(dsn,only)['tables'].values())
ok('all registered rows and files rekeyed; old key removed; business revisions and file hashes unchanged')
# The process may stop between batches. A repeated conversion performs no writes.
again=transition(dsn,only,uploads,private,'convert')
assert sum(t['converted'] for t in again['database']['tables'].values())==0 and again['files']['converted']==0
ok('conversion is restartable and idempotent after completed checkpoints')
archive=subprocess.check_output(['docker','exec',DB,'pg_dump','-U','postgres','-d','gps_closure_test','-Fc'])
command('docker','exec',DB,'createdb','-U','postgres','gps_crypto20b_restore')
command('docker','exec',DB,'psql','-U','postgres','-d','gps_crypto20b_restore','-v','ON_ERROR_STOP=1','-c','CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();',stdout=subprocess.DEVNULL)
command('docker','exec','-i',DB,'pg_restore','-U','postgres','-d','gps_crypto20b_restore','--exit-on-error',input=archive)
command('docker','exec',DB,'psql','-U','postgres','-d','gps_crypto20b_restore','-v','ON_ERROR_STOP=1','-c','SELECT timescaledb_post_restore();',stdout=subprocess.DEVNULL)
restore=dsn.rsplit('/',1)[0]+'/gps_crypto20b_restore'
with psycopg.connect(restore,autocommit=True) as restored:
    try:restored.execute('SELECT center_lat FROM gps_read_geofences LIMIT 1').fetchone()
    except psycopg.Error:pass
    else:raise AssertionError('restored ciphertext read without key')
    restored.execute("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(only),))
    assert fingerprint(restored)==before
    backup_roots=HERE/'restored-storage'
    shutil.copytree(HERE/'test-storage',backup_roots)
    assert convert_files(restored,str(backup_roots/'uploads'),str(backup_roots/'private'),only)['content_hashes']==files_before['content_hashes']
    # Stop restored Timescale background jobs until the disposable DB is removed.
    restored.execute('SELECT timescaledb_pre_restore()')
ok('full Timescale backup restored without supplying keys to pg_restore; separate key recovers all logical fingerprints')
transition(dsn,only,uploads,private,'resume')
# Run the serving role helper with psycopg3 instead of the psycopg2 SQL-literal key path.
# It generates only this isolated runtime password, not any encryption key.
source=(HERE/'admin_db_roles.py').read_text().replace('import psycopg2','import psycopg as psycopg2').replace('from psycopg2 import sql','from psycopg import sql')
module={};exec(compile(source,'admin_db_roles.py','exec'),module)
credential=HERE/'test-runtime.json';module['run'](dsn,True,credential)
cred=json.loads(credential.read_text());runtime_dsn=dsn.replace('postgres:closure-test-only',cred['user']+':'+cred['password'])
cfg={'DATABASE_URL':runtime_dsn,'GPS_LOCATION_ENCRYPTION':'pilot','GPS_LOCATION_KEYRING_FILE':str(keyfile)}
worker=worker_connect(cfg)
with worker.transaction(),worker.cursor() as c:
    c.execute('SELECT center_lat FROM gps_read_geofences LIMIT 1');assert c.fetchone()[0] is not None
    c.execute('SELECT min(id) FROM users');sample_user=c.fetchone()[0]
from privacy_scope_inventory import account_scope
account_scope(worker,sample_user)
account_scope(worker,sample_user)
worker.close()
try:worker_connect({**cfg,'GPS_LOCATION_ENCRYPTION':'off'})
except ValueError:pass
else:raise AssertionError('worker accepted policy mismatch')
transition(dsn,only,uploads,private,'fence')
try:worker_connect(cfg)
except ValueError:pass
else:raise AssertionError('worker started during maintenance')
with psycopg.connect(dsn,autocommit=True) as owner:
    owner.execute("CREATE FUNCTION crypto20b_fence_probe() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'UPDATE users SET display_name=display_name'; GRANT EXECUTE ON FUNCTION crypto20b_fence_probe() TO gps_runtime")
with psycopg.connect(runtime_dsn,autocommit=True) as runtime:
    runtime.execute("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(only),))
    runtime.execute("SET gps.storage_rewrite='on'")
    assert runtime.execute('SELECT gps_storage_rewrite_allowed()').fetchone()[0] is False
    for q in ['UPDATE users SET display_name=display_name','SELECT crypto20b_fence_probe()','UPDATE location_storage_policy SET maintenance=false','ALTER TABLE geofences DISABLE TRIGGER ALL','DROP VIEW gps_read_geofences']:
        try:runtime.execute(q)
        except psycopg.Error:pass
        else:raise AssertionError('runtime bypassed fence/DDL isolation')
with psycopg.connect(dsn,autocommit=True) as owner:owner.execute('DROP FUNCTION crypto20b_fence_probe()')
transition(dsn,only,uploads,private,'resume')
command('bash',str(HERE/'dev20b.sh'),'api',env={**os.environ,'STORAGE':'pilot','RUNTIME_DSN':runtime_dsn})
ok('restricted runtime API starts; worker decrypts safely; missing mode, maintenance, policy changes and DDL bypass fail')
result={'environment':'isolated synthetic only','schema':104,'groups':groups,'rotation_seconds':round(elapsed,3),
        'compressed_chunks':compressed,'rotation':rotation,'full_restore_fingerprints_equal':True,
        'backup_bytes':len(archive),'old_wal_backups_erased':False,'api_sha256':hashlib.sha256((HERE/'out/gps-tracker-api').read_bytes()).hexdigest()}
(HERE/'out/recovery.json').write_text(json.dumps(result,indent=2))
