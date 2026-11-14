"""105 -> 106 isolated migration rehearsal using the verified previous binary."""
import hashlib,json,pathlib,subprocess
import psycopg
HERE=pathlib.Path(__file__).resolve().parent
assert str(HERE).startswith('/home/etcom-hub/build/gps-provision22-')
NET='gps-provision22-test-20261108';DB='gps-provision22-db-20261108'
inspect=lambda kind,name:json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NET)['Internal']
assert '/var/lib/postgresql/data' in inspect('container',DB)['HostConfig']['Tmpfs']
name='gps_provision22_upgrade'
subprocess.run(['docker','exec',DB,'createdb','-U','postgres',name],check=True)
dsn='postgres://postgres:closure-test-only@'+inspect('container',DB)['NetworkSettings']['Networks'][NET]['IPAddress']+'/'+name
old=pathlib.Path('/home/etcom-hub/build/gps-lifecycle21-20261107/out/gps-tracker-api')
assert hashlib.sha256(old.read_bytes()).hexdigest()=='f10f9e532c0a42b1a0e1887dfe36f09e1b4af2ed8a77acf5fd42c02243df0b16'
def migrate(binary):
 subprocess.run(['docker','run','--rm','--network',NET,'--memory=550m','--cap-drop=ALL','--security-opt=no-new-privileges','-e','APP_ENV=test','-e','GPS_MIGRATE_ONLY=1','-e','DATABASE_URL=postgres://postgres:closure-test-only@closure-db/'+name,'-e','JWT_SECRET=synthetic-21-upgrade-test-only-key','-v',str(binary)+':/api:ro','gps-build:rust1.88-node22.22.2','/api'],check=True)
migrate(old)
with psycopg.connect(dsn,autocommit=True) as db:
 uid=db.execute("INSERT INTO users(email,phone,password_hash) VALUES('upgrade21@example.invalid','synthetic21','no-login') RETURNING id").fetchone()[0]
 did=db.execute("INSERT INTO devices(owner_id,device_uid,iccid,api_key_hash) VALUES(%s,'upgrade21','8988000000000000021','') RETURNING id",(uid,)).fetchone()[0]
 db.execute("INSERT INTO location_records(device_id,user_id,source,lat,lng,fix,recorded_at) VALUES(%s,%s,'l80',37,127,true,now())",(did,uid))
 def fingerprint():return db.execute("SELECT md5(jsonb_build_array((SELECT jsonb_agg(to_jsonb(u)) FROM users u),(SELECT jsonb_agg(to_jsonb(d)) FROM devices d),(SELECT jsonb_agg(to_jsonb(r)) FROM location_records r))::text)").fetchone()[0]
 before=fingerprint()
 migration=HERE/'src/gps-tracker-api/migrations/0106_subject_provision.sql'
 try:
  with db.transaction():db.execute(migration.read_text());db.execute('SELECT 1/0')
 except psycopg.Error:pass
 assert db.execute("SELECT to_regclass('location_subject_mappings') IS NULL").fetchone()[0]
 assert fingerprint()==before
 migrate(HERE/'out/gps-tracker-api')
 assert fingerprint()==before
 assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()[0]==106
 assert not db.execute('SELECT enabled OR push_enabled FROM location_subject_policy').fetchone()[0]
 assert db.execute('SELECT count(*) FROM location_subject_mappings').fetchone()[0]==0
 for version,checksum in db.execute('SELECT version,checksum FROM _sqlx_migrations'):
  f=next((HERE/'src/gps-tracker-api/migrations').glob(f'{version:04}_*.sql'))
  assert hashlib.sha384(f.read_bytes()).digest()==bytes(checksum)
 result={'schema_path':[105,106],'identity_sim_records_unchanged':True,'failed_106_transaction_atomic':True,'subject_policy_default_off':True,'no_inferred_consent':True,'migration_checksums_match':True,'api_sha256':hashlib.sha256((HERE/'out/gps-tracker-api').read_bytes()).hexdigest()}
 (HERE/'out/upgrade22.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
subprocess.run(['docker','exec',DB,'dropdb','-U','postgres',name],check=True)
