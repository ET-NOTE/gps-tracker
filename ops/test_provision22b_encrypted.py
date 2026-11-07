"""Round22 integration with encryption and non-owner API role, isolated only."""
import json,os,pathlib,subprocess,sys
import psycopg
from location_storage import create_keyring
from crypto20b_transition import run as convert
from admin_db_roles import run as roles
HERE=pathlib.Path(__file__).resolve().parent
assert str(HERE).startswith('/home/etcom-hub/build/gps-provision22-')
NET='gps-provision22-test-20261108b';DB='gps-provision22-db-20261108b'
inspect=lambda kind,name:json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NET)['Internal']
assert '/var/lib/postgresql/data' in inspect('container',DB)['HostConfig']['Tmpfs']
dsn='postgres://postgres:closure-test-only@'+inspect('container',DB)['NetworkSettings']['Networks'][NET]['IPAddress']+'/gps_closure_test'
subprocess.run(['bash',str(HERE/'dev22.sh'),'stop'],check=True)
key=HERE/'test-keys.json'
if not key.exists():create_keyring(key)
ring=json.loads(key.read_text())
for mode in ('fence','convert','resume'):
 report=convert(dsn,ring,str(HERE/'test-storage/uploads'),str(HERE/'test-storage/private'),mode)
assert report['ready_to_start_key_configured_api']
secret=HERE/'test-runtime.json'
if not secret.exists():roles(dsn,True,str(secret))
cred=json.loads(secret.read_text())
runtime=dsn.replace('postgres:closure-test-only',cred['user']+':'+cred['password'])
with psycopg.connect(runtime,autocommit=True) as db:
 for statement in ["UPDATE location_subject_policy SET enabled=true",'DELETE FROM location_subject_actions','DELETE FROM location_notice_attempts','DELETE FROM location_provision_notices','ALTER TABLE location_subject_mappings DISABLE TRIGGER ALL']:
  try:db.execute(statement)
  except psycopg.errors.InsufficientPrivilege:pass
  else:raise AssertionError('runtime privilege escalation')
env=dict(os.environ,STORAGE='pilot',RUNTIME_DSN=runtime,LEDGER='off',SUBJECTS='off')
subprocess.run(['bash',str(HERE/'dev22.sh'),'api'],env=env,check=True)
subprocess.run([sys.executable,str(HERE/'test_provision22b.py')],env=env,check=True)
fixture=json.loads((HERE/'out/round22b-encrypted.json').read_text())['fixture']
with psycopg.connect(dsn,autocommit=True) as db:
 assert db.execute('SELECT bool_and(lat IS NULL AND lng IS NULL) FROM location_records WHERE device_id=%s',(fixture['device'],)).fetchone()==(True,)
 db.execute("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ring),))
 assert db.execute('SELECT count(*) FROM gps_read_location_records WHERE device_id=%s AND lat IS NOT NULL',(fixture['device'],)).fetchone()[0]>0
out={'encryption_enabled':True,'raw_coordinates_null':True,'decrypted_read_passed':True,'nonowner_api_integration_passed':True,'five_privilege_denials':True,'no_external_send':True}
(HERE/'out/round22b-encrypted-roles.json').write_text(json.dumps(out,indent=2));print(json.dumps(out))
