"""Synthetic offline conversion and live API regression. Internal Docker only."""
import base64, hashlib, json, os, pathlib, subprocess, urllib.request, urllib.error, uuid
import psycopg



HERE=pathlib.Path(__file__).resolve().parent
NET='gps-lifecycle21-test-20261105';DB='gps-lifecycle21-db-20261105';API='gps-lifecycle21-api-20261105'
assert str(HERE).startswith('/home/etcom-hub/build/gps-lifecycle21-')
def inspect(kind,name):return json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NET)['Internal']
assert '/var/lib/postgresql/data' in inspect('container',DB)['HostConfig']['Tmpfs']
dsn='postgres://postgres:closure-test-only@'+inspect('container',DB)['NetworkSettings']['Networks'][NET]['IPAddress']+'/gps_closure_test'
db=psycopg.connect(dsn,autocommit=True)
def sql(q,args=()):
 with db.cursor() as c:c.execute(q,args);return c.fetchone()[0] if c.description else None
def request(method,path,body=None,token=None,headers=None):
 host=inspect('container',API)['NetworkSettings']['Networks'][NET]['IPAddress']
 h={'Content-Type':'application/json',**(headers or {})}
 if token:h['Authorization']='Bearer '+token
 data=body if isinstance(body,bytes) else json.dumps(body).encode() if body is not None else None
 try:r=urllib.request.urlopen(urllib.request.Request('http://'+host+':3043/gps-tracker/api/v1'+path,method=method,data=data,headers=h),timeout=30)
 except urllib.error.HTTPError as e:r=e
 with r:
  b=r.read();return r.status,json.loads(b) if 'application/json' in r.headers.get('content-type','') else b
tag=uuid.uuid4().hex[:10];passed=[]
def ok(s):passed.append(s);print('PASS '+s,flush=True)
def account(n):
 phone='010'+str(int(tag,16)+n)[-8:]
 s,o=request('POST','/auth/send-otp',{'phone':phone});assert s==200,(s,o)
 s,u=request('POST','/auth/register',{'phone':phone,'email':f'{tag}-{n}@example.invalid','otp_code':o['dev_code'],'display_name':'Crypto20B fixture','password':'Synthetic-only-123!'});assert s==200,(s,u);return u

from privacy_retention import run as retain
from location_storage import create_keyring
from crypto20b_transition import run as transition
from admin_db_roles import run as roles
owner=account(4);uid=owner['user_id'];token=owner['access_token']
did=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,%s,'') RETURNING id",(uid,'encrypted21-'+tag))
sql("INSERT INTO privacy_retention_consents(user_id,months,consent_reference) VALUES(%s,6,'synthetic-consent')",(uid,))
sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',now()-interval '7 months',37.123456,127.123456,true)",(did,uid))
sql("INSERT INTO location_1min(device_id,bucket,lat_avg,lng_avg,lat_last,lng_last) VALUES(%s,now()-interval '7 months',37,127,37,127)",(did,))
keyfile=HERE/'test-keys.json';create_keyring(keyfile);ring=json.loads(keyfile.read_text())
db.close();subprocess.run(['bash',str(HERE/'dev21.sh'),'stop'],check=True)
roots=(str(HERE/'test-storage/uploads'),str(HERE/'test-storage/private'))
transition(dsn,ring,*roots,'fence');transition(dsn,ring,*roots,'convert');transition(dsn,ring,*roots,'resume')
cfg={'DATABASE_URL':dsn,'GPS_LOCATION_ENCRYPTION':'pilot','GPS_LOCATION_KEYRING_FILE':str(keyfile)}
result=retain(cfg,True)
db=psycopg.connect(dsn,autocommit=True);sql("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ring),))
assert sql('SELECT count(*) FROM location_records WHERE user_id=%s',(uid,))==0
assert sql('SELECT count(*) FROM location_1min WHERE device_id=%s',(did,))==1
assert sql('SELECT count(*) FROM gps_read_location_1min WHERE device_id=%s',(did,))==0
ok('encrypted erasure removes raw cells; ambiguous legacy aggregate quarantined from read view without deleting another subject')
# Explicitly shared company material is reviewed, never silently auto-deleted.
vid=sql("INSERT INTO fleet_vehicles(owner_id,name) VALUES(%s,'Review fixture') RETURNING id",(uid,))
held=retain(cfg,True)['accounts']
assert not next(x for x in held if x['account_id']==uid)['eligible']
ok('company ownership produces review-required hold instead of automatic deletion')
secrets=HERE/'test-runtime.json';secrets.unlink(missing_ok=True)
db.close();roles(dsn,True,str(secrets));creds=json.loads(secrets.read_text())
runtime=dsn.replace('postgres:closure-test-only@','gps_runtime:'+creds['password']+'@')
rdb=psycopg.connect(runtime,autocommit=True)
for statement in ['UPDATE privacy_retention_policy SET enabled=false','DELETE FROM privacy_retention_runs','UPDATE privacy_retention_consents SET months=12','DELETE FROM privacy_processing_events','ALTER TABLE privacy_processing_controls DISABLE TRIGGER ALL']:
 try:rdb.execute(statement)
 except psycopg.Error:pass
 else:raise AssertionError('runtime privilege exceeded: '+statement)
rdb.close()
subprocess.run(['bash',str(HERE/'dev21.sh'),'api'],env={**os.environ,'STORAGE':'pilot','RUNTIME_DSN':runtime,'LEDGER':'on'},check=True)
assert request('GET','/privacy/processing',token=token)[0]==200
assert request('POST','/privacy/processing',{'revision':0,'use_paused':True,'provision_paused':False},token)[0]==200
assert request('GET','/devices',token=token)[0]==423
assert request('GET','/privacy/requests',token=token)[0]==200
assert request('POST','/privacy/processing',{'revision':1,'use_paused':False,'provision_paused':False},token)[0]==200
ok('encrypted runtime role can enforce and resume controls with ledger ON; cannot change retention/erasure records or disable guards')
(HERE/'out/lifecycle21-encrypted.json').write_text(json.dumps({'groups':passed,'schema':105,'api_sha256':hashlib.sha256((HERE/'out/gps-tracker-api').read_bytes()).hexdigest()},indent=2))
