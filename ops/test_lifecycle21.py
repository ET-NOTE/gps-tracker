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
owner,other=account(1),account(2);uid=owner['user_id'];token=owner['access_token'];otherid=other['user_id']
cfg={'DATABASE_URL':dsn}
did=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,%s,'') RETURNING id",(uid,'lifecycle21-'+tag))
sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',now(),37,127,true)",(did,uid))
link='lifecycle21-'+tag
sql("INSERT INTO share_tokens(token,device_id,created_by,expires_at) VALUES(%s,%s,%s,now()+interval '1 day')",(link,did,uid))
path=f'/devices/{did}/locations/latest'
assert request('GET',path,token=token)[0]==200
assert request('GET','/share/'+link)[0]==200
assert request('GET','/privacy/processing')[0]==401
def change(use,provide,rev):return request('POST','/privacy/processing',{'use_paused':use,'provision_paused':provide,'revision':rev},token)
assert change(False,True,0)[0]==200
assert request('GET',path,token=token)[0]==200
assert request('GET','/share/'+link)[0]==423
assert change(True,True,0)[0]==409
assert change(True,False,1)[0]==200
assert request('GET',path,token=token)[0]==423
assert request('GET','/share/'+link)[0]==423
assert request('GET','/privacy/requests',token=token)[0]==200
assert request('GET','/privacy/collection',token=token)[0]==200
assert request('GET','/devices',token=other['access_token'])[0]==200
assert sql('SELECT count(*) FROM location_access_events')==0
ok('ledger OFF: independent provision/use controls, existing share denied, self rights and other account preserved; stale revisions rejected')
# A response/external-send fence must drain before changing the policy.
lease=psycopg.connect(dsn);lease.execute('SELECT pg_advisory_xact_lock_shared(210571031)')
assert change(False,False,2)[0]==409
lease.rollback();lease.close()
assert change(False,False,2)[0]==200
ok('in-flight fence returns conflict without pretending pause succeeded; resume succeeds after drain')
assert change(True,False,3)[0]==200
sql("INSERT INTO ai_analyses(user_id,device_id,target_date,analysis) VALUES(%s,%s,current_date,'blocked')",(uid,did))
assert sql('SELECT count(*) FROM ai_analyses WHERE user_id=%s',(uid,))==0
sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',now(),37,127,true)",(did,uid))
assert sql('SELECT count(*) FROM location_records WHERE user_id=%s',(uid,))==2
ok('use pause suppresses automatic derived writes while collection remains independent')
assert change(False,False,4)[0]==200
try:retain(cfg,True)
except ValueError:pass
else:raise AssertionError('OFF retention deleted data')
sql("INSERT INTO privacy_retention_consents(user_id,months,consent_reference) VALUES(%s,6,'synthetic-consent')",(uid,))
for who,age in [(uid,'7 months'),(otherid,'7 months'),(uid,'5 months')]:
 sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',now()-%s::interval,37,127,true)",(did,who,age))
sql("INSERT INTO events(device_id,user_id,kind,occurred_at,data) VALUES(%s,%s,'wake',now()-interval '7 months','{\"lat\":37}')",(did,uid))
sql("INSERT INTO ai_analyses(user_id,device_id,target_date,analysis) VALUES(%s,%s,current_date-interval '7 months','old')",(uid,did))
preview=retain(cfg,False);assert preview['accounts'][0]['counts']['location_records']==1
sql("UPDATE privacy_retention_policy SET enabled=true,policy_reference='synthetic-policy' WHERE singleton")
result=retain(cfg,True)
assert result['accounts'][0]['covered_rows_erased']
assert sql('SELECT count(*) FROM location_records WHERE user_id=%s',(otherid,))==1
assert sql('SELECT count(*) FROM location_records WHERE user_id=%s',(uid,))==3
assert sql('SELECT count(*) FROM ai_analyses WHERE user_id=%s',(uid,))==0
try:sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',now()-interval '7 months',37,127,true)",(did,uid))
except psycopg.Error:pass
else:raise AssertionError('erased history resurrected')
sql("INSERT INTO ai_analyses(user_id,device_id,target_date,analysis) VALUES(%s,%s,current_date-interval '7 months','late derive')",(uid,did))
assert sql('SELECT count(*) FROM ai_analyses WHERE user_id=%s',(uid,))==0
ok('six calendar months, no inferred consent, original/event/AI erasure, other historical SIM owner preserved, replay and late derivation blocked')
try:sql("UPDATE privacy_retention_consents SET months=12,contract_until=NULL WHERE user_id=%s",(uid,))
except psycopg.Error:pass
else:raise AssertionError('long retention without contract accepted')
sql("UPDATE privacy_retention_consents SET months=12,contract_until=now()-interval '1 day' WHERE user_id=%s",(uid,))
assert retain(cfg,True)['accounts'][0]['covered_rows_erased']
assert sql('SELECT count(*) FROM location_records WHERE user_id=%s',(uid,))==0
ok('twelve months requires contract; expired contract removes remaining covered telemetry')
# Export latest controls/cutoffs, then simulate an older DB under an offline restore.
assert change(True,True,5)[0]==200
sql('UPDATE device_data_controls SET collection_paused=true,collection_enforced=true,collection_ack_epoch=collection_epoch,collection_ack_at=now() WHERE device_id=%s',(did,))
old_epoch=sql('SELECT collection_epoch FROM device_data_controls WHERE device_id=%s',(did,))
sql('UPDATE privacy_account_controls SET restricted=true,restricted_at=now() WHERE user_id=%s',(otherid,))
checkpoint=HERE/'test-checkpoint.json';checkpoint.unlink(missing_ok=True)
report=export(cfg,checkpoint)
try:restore(cfg,checkpoint,'0'*64)
except ValueError:pass
else:raise AssertionError('incorrect checkpoint accepted')
try:restore(cfg,checkpoint,report['sha256'])
except ValueError:pass
else:raise AssertionError('online restore accepted')
db.close();subprocess.run(['bash',str(HERE/'dev21.sh'),'stop'],check=True)
db=psycopg.connect(dsn,autocommit=True)
sql("UPDATE device_data_controls SET collection_paused=false,collection_enforced=false,collection_changed_at=now()-interval '1 day' WHERE device_id=%s",(did,))
sql('UPDATE privacy_account_controls SET restricted=false WHERE user_id=%s',(otherid,))
sql('DELETE FROM privacy_retention_runs WHERE user_id=%s',(uid,))
sql('UPDATE privacy_processing_controls SET use_paused=false,provision_paused=false,revision=0 WHERE user_id=%s',(uid,))
sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',now()-interval '8 months',37,127,true)",(did,uid))
db.close();restored=restore(cfg,checkpoint,report['sha256'])
assert restored['replayed_accounts']==1
db=psycopg.connect(dsn,autocommit=True)
assert sql('SELECT count(*) FROM location_records WHERE user_id=%s',(uid,))==0
assert sql('SELECT use_paused AND provision_paused FROM privacy_processing_controls WHERE user_id=%s',(uid,))
assert sql('SELECT collection_paused AND collection_enforced AND collection_ack_epoch IS NULL AND collection_ack_at IS NULL AND collection_epoch<>%s FROM device_data_controls WHERE device_id=%s',(old_epoch,did))
assert sql('SELECT restricted FROM privacy_account_controls WHERE user_id=%s',(otherid,))
ok('offline checkpoint replays collection/account/use pause with fresh ACK epoch and deletion cutoff; incorrect hash/live restore rejected; no backup-erasure claim')
db.close();subprocess.run(['bash',str(HERE/'dev21.sh'),'api'],check=True)
(HERE/'out/lifecycle21.json').write_text(json.dumps({'groups':passed,'retention':result,'restore':restored,'api_sha256':hashlib.sha256((HERE/'out/gps-tracker-api').read_bytes()).hexdigest()},indent=2))
assert request('GET',path,token=token)[0]==423
assert change(False,False,6)[0]==200
checkpoint.unlink()
