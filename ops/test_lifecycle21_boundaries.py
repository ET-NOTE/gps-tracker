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
from privacy_restore_checkpoint import export, restore

# Run after the encrypted/runtime suite on the same disposable DB.
from privacy_worker_db import connect
cfg={'DATABASE_URL':dsn,'GPS_LOCATION_ENCRYPTION':'pilot','GPS_LOCATION_KEYRING_FILE':str(HERE/'test-keys.json')}
db.close();db=connect(cfg);db.autocommit=True
owner,other=account(8),account(9);uid=owner['user_id'];otherid=other['user_id']
did=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,%s,'') RETURNING id",(uid,'boundary21-'+tag))
sql("INSERT INTO privacy_retention_consents(user_id,months,consent_reference) VALUES(%s,6,'synthetic-boundary')",(uid,))
sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',now()-interval '7 months',37,127,true)",(did,uid))
sql("INSERT INTO ai_analyses(user_id,device_id,target_date,analysis) VALUES(%s,%s,current_date-interval '7 months','synthetic old')",(uid,did))
sql("CREATE FUNCTION test21_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic interruption'; END $$")
sql("CREATE TRIGGER test21_delete_failure BEFORE DELETE ON ai_analyses FOR EACH ROW EXECUTE FUNCTION test21_delete_failure()")
try:retain(cfg,True)
except psycopg.Error:pass
else:raise AssertionError('injected failure ignored')
assert sql('SELECT count(*) FROM location_records WHERE user_id=%s',(uid,))==1
assert sql('SELECT count(*) FROM privacy_retention_runs WHERE user_id=%s',(uid,))==0
sql('DROP TRIGGER test21_delete_failure ON ai_analyses');sql('DROP FUNCTION test21_delete_failure()')
ok('failure after raw deletion rolls back the whole account; no success tombstone')
# Same SIM, different account: preserve new owner cache and other historical rows.
sql('UPDATE devices SET owner_id=%s,last_lat=38,last_lng=128,last_fix_at=now() WHERE id=%s',(otherid,did))
sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',now()-interval '7 months',38,128,true)",(did,otherid))
retain(cfg,True)
assert sql('SELECT count(*) FROM location_records WHERE user_id=%s',(uid,))==0
assert sql('SELECT count(*) FROM location_records WHERE user_id=%s',(otherid,))==1
assert sql('SELECT last_lat FROM gps_read_devices WHERE id=%s',(did,))==38
cutoff=sql('SELECT max(cutoff) FROM privacy_retention_runs WHERE user_id=%s',(uid,))
sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',%s,37,127,true)",(did,uid,cutoff))
try:sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',%s-interval '1 microsecond',37,127,true)",(did,uid,cutoff))
except psycopg.Error:pass
else:raise AssertionError('strict cutoff bypassed')
ok('SIM transfer preserves new owner and cache; exact cutoff accepted, earlier replay rejected')
(HERE/'out/lifecycle21-boundaries.json').write_text(json.dumps({'groups':passed},indent=2))
db.close()
