"""Synthetic offline conversion and live API regression. Internal Docker only."""
import base64, hashlib, json, os, pathlib, subprocess, urllib.request, urllib.error, uuid
import psycopg



HERE=pathlib.Path(__file__).resolve().parent
NET='gps-provision22-test-20261111cumulative111';DB='gps-provision22-db-20261111cumulative111';API='gps-provision22-api-20261111cumulative111'
assert str(HERE).startswith('/home/etcom-hub/build/gps-provision22-')
def inspect(kind,name):return json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NET)['Internal']
digest=hashlib.sha256((HERE/'out/gps-tracker-api').read_bytes()).hexdigest()
assert subprocess.check_output(['docker','exec',API,'sha256sum','/proc/1/exe']).decode().split()[0]==digest
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
if os.environ.get('STORAGE')=='pilot':
 ring=json.loads((HERE/'test-keys.json').read_text());sql("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ring),))
tag=uuid.uuid4().hex[:10];passed=[]
def ok(s):passed.append(s);print('PASS '+s,flush=True)
def account(n):
 phone='010'+str(int(tag,16)+n)[-8:]
 s,o=request('POST','/auth/send-otp',{'phone':phone});assert s==200,(s,o)
 s,u=request('POST','/auth/register',{'phone':phone,'email':f'{tag}-{n}@example.invalid','otp_code':o['dev_code'],'display_name':'Round22 fixture','password':'Synthetic-only-123!'});assert s==200,(s,u);return u


from datetime import datetime,timedelta,timezone
from urllib.parse import urlencode
owner,driver,other,driver2=account(1),account(2),account(3),account(4)
u=owner['user_id'];s=driver['user_id'];o=other['user_id'];s2=driver2['user_id']
token=owner['access_token'];dtoken=driver['access_token']
assert request('GET','/privacy/subject-mappings')[0]==401
assert request('GET','/privacy/subject-mappings',token=dtoken)[1]['enabled'] is False
assert request('POST','/corporate/subject-mappings',{},token)[0] in (400,409,422)
start=datetime.now(timezone.utc).replace(microsecond=0)-timedelta(hours=1);end=start+timedelta(hours=2)
did=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash,iccid) VALUES(%s,%s,'',%s) RETURNING id",(u,'provision22-'+tag,'8988228066'+str(int(tag,16))))
vehicle=sql("INSERT INTO fleet_vehicles(owner_id,name) VALUES(%s,'합성 시험 차량') RETURNING id",(u,))
binding=sql("INSERT INTO fleet_vehicle_bindings(owner_id,vehicle_id,device_id,terminal_name,started_at) VALUES(%s,%s,%s,'SIM fixture',%s) RETURNING id",(u,vehicle,did,start-timedelta(days=1)))
def staff(who):
 sid=sql("INSERT INTO staff(user_id,name,active,access_role) VALUES(%s,'시험 운전자',true,'member') RETURNING id",(u,))
 sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(u,sid,who));return sid
sid=staff(s);sid2=staff(s2)
identity=sql('SELECT md5(row_to_json(d)::text) FROM devices d WHERE id=%s',(did,))
sql("UPDATE location_subject_policy SET enabled=true,reference='isolated-round22-policy',push_enabled=false")
env=dict(os.environ,LEDGER='on',SUBJECTS='on')
subprocess.run(['bash',str(HERE/'dev22.sh'),'api'],env=env,check=True)
def proposal(staff_id=sid,a=start,b=end):return {'request_key':str(uuid.uuid4()),'staff_id':staff_id,'binding_id':binding,'starts_at':a.isoformat(),'ends_at':b.isoformat()}
body=proposal();code,m=request('POST','/corporate/subject-mappings',body,token);assert code==200,(code,m);mid=m['id']
assert request('POST','/corporate/subject-mappings',body,token)[1]['id']==mid
assert request('POST','/corporate/subject-mappings',{**body,'ends_at':(end+timedelta(minutes=1)).isoformat()},token)[0]==409
assert request('POST','/corporate/subject-mappings',proposal(),other['access_token'])[0]==404
assert request('POST','/corporate/subject-mappings',proposal(),dtoken,{'X-Fleet-Owner':str(u)})[0]==403
assert request('GET','/privacy/subject-mappings',token=dtoken)[1]['items'][0]['status']=='pending'
def decision(m,who,action='confirmed',rev=0):return request('POST',f'/privacy/subject-mappings/{m}/decision',{'action':action,'revision':rev,'consent_version':'fleet-subject-v1'},who)
assert decision(mid,token)[0]==404
assert decision(mid,dtoken)[0]==200
assert decision(mid,dtoken)[0]==409
assert sql('SELECT count(*) FROM location_subject_actions WHERE mapping_id=%s',(mid,))==2
ok('subject-only confirmation, company roles, tenant denial, idempotent proposals and stale revisions')
code,m2=request('POST','/corporate/subject-mappings',proposal(sid2),token);assert code==200,(code,m2)
assert decision(m2['id'],driver2['access_token'])[0]==409
assert decision(m2['id'],driver2['access_token'],'rejected')[0]==200
ok('same-SIM overlapping confirmed driver rejected atomically; explicit rejection retained')
# Synthetic coordinates at start, inside and exclusive end. End belongs to next interval.
for t in [start,start+timedelta(minutes=1),end]:
 sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',%s,37,127,true)",(did,u,t))
path=f'/corporate/subject-mappings/{mid}/locations'
assert request('GET',path,token=other['access_token'])[0]==404
assert request('GET',f'/devices/{did}/locations/latest?'+urlencode({'since':start.isoformat(),'until':end.isoformat()}),token=token)[0]==503
code,result=request('GET',path+'?since=2000-01-01&until=2099-01-01',token=token);assert code==200,(code,result)
assert len(result['items'])==2,result
notes=request('GET','/privacy/provision-notices',token=dtoken)[1]['items'];assert len(notes)==1,notes
notice=notes[0];nid=notice['id'];assert notice['owner_id']==u and notice['actor_id']==u and notice['delivery']=='pending' and notice['read_at'] is None
assert not request('GET','/privacy/provision-notices',token=other['access_token'])[1]['items']
assert request('POST',f'/privacy/provision-notices/{nid}/read',{},other['access_token'])[0]==404
assert request('POST',f'/privacy/provision-notices/{nid}/read',{},dtoken)[0]==200
assert request('POST',f'/privacy/provision-notices/{nid}/read',{},dtoken)[0]==200
sql('UPDATE fleet_vehicle_bindings SET ended_at=%s WHERE id=%s',(start+timedelta(minutes=30),binding))
assert request('GET',path,token=token)[0]==503
assert sql('SELECT count(*) FROM location_provision_notices WHERE subject_id=%s',(s,))==1
sql('UPDATE fleet_vehicle_bindings SET ended_at=NULL WHERE id=%s',(binding,))
ok('bounded actual location response; ignored widening query; changed vehicle binding blocked; one durable subject notice and account-isolated acknowledgement')
# Shared fence protects revocation while a response is in flight.
lease=psycopg.connect(dsn);lease.execute('SELECT pg_advisory_xact_lock_shared(210571031)')
assert decision(mid,dtoken,'revoked',1)[0]==409
lease.rollback();lease.close()
# Historical subject protection survives staff unlink and recorder OFF.
assert request('POST','/privacy/processing',{'use_paused':False,'provision_paused':True,'revision':0},dtoken)[0]==200
sql('DELETE FROM fleet_staff_accounts WHERE account_id=%s',(s,))
assert request('GET',path,token=token)[0]==404  # 22D: unlinked mapping is not an effective resource
assert request('GET','/privacy/provision-notices',token=dtoken)[0]==200
assert decision(mid,dtoken,'revoked',1)[0]==200
subprocess.run(['bash',str(HERE/'dev22.sh'),'api'],env=dict(os.environ,LEDGER='off',SUBJECTS='off'),check=True)
assert request('GET',f'/devices/{did}/locations/latest',token=token)[0]==423
assert sql('SELECT count(*) FROM location_provision_notices WHERE subject_id=%s',(s,))==1
ok('in-flight revocation fence; former staff pause/revocation persists with feature and ledger OFF; rights inbox remains available')
# A new hardware authentication uid does not change SIM mapping IDs or prior notices.
old_uid=sql('SELECT device_uid FROM devices WHERE id=%s',(did,))
sql("UPDATE devices SET active_auth_uid='replacement-hardware' WHERE id=%s",(did,))
assert sql('SELECT device_id FROM location_subject_mappings WHERE id=%s',(mid,))==did
assert sql('SELECT device_uid FROM devices WHERE id=%s',(did,))==old_uid
assert sql('SELECT device_id FROM location_provision_notices WHERE id=%s',(nid,))==did
ok('SIM identity remains the telemetry key across changed hardware auth identity')
# Manual retry is durable and cannot revive a successful delivery or bypass tenant authorization.
sql("UPDATE location_provision_notices SET delivery='review',attempts=10,last_error='transport' WHERE id=%s",(nid,))
assert request('POST',f'/privacy/provision-notices/{nid}/retry',{},other['access_token'])[0]==409
assert request('POST',f'/privacy/provision-notices/{nid}/retry',{},dtoken)[0]==200
assert request('POST',f'/privacy/provision-notices/{nid}/retry',{},dtoken)[0]==409
assert sql("SELECT count(*) FROM location_notice_attempts WHERE notice_id=%s AND result='subject_retry_requested'",(nid,))==1
ok('review queue retry is explicit, audited, subject-only and idempotent by state')
# Cursor pagination must not hide an older confirmed/revoked subject request.
for n in range(201):
 sql("INSERT INTO location_subject_mappings(request_key,owner_id,subject_id,proposed_by,staff_id,vehicle_id,binding_id,device_id,starts_at,ends_at,status) SELECT gen_random_uuid(),owner_id,subject_id,proposed_by,staff_id,vehicle_id,binding_id,device_id,starts_at,ends_at,'rejected' FROM location_subject_mappings WHERE id=%s",(mid,))
page=request('GET','/privacy/subject-mappings',token=dtoken)[1];assert len(page['items'])==200
older=request('GET','/privacy/subject-mappings?before='+str(page['next_before']),token=dtoken)[1]
assert any(r['id']==mid and r['status']=='revoked' for r in older['items'])
assert all(r['subject_id']==s for r in older['items'])
ok('cursor pagination retains access to old revocations and never changes subject scope')
# Stop stale backup restore from silently reviving consent: covered by checkpoint regression.
result={'api_sha256':digest,'suite':'round22','passed':passed,'schema':sql('SELECT max(version) FROM _sqlx_migrations'),'fixture':{'owner':u,'subject':s,'vehicle':vehicle,'device':did,'mapping':mid,'notice':nid},'production_modified':False,'external_messages':0}
(HERE/('out/round22-encrypted-integration.json' if os.environ.get('STORAGE')=='pilot' else 'out/round22-integration.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({'passed':len(passed),'schema':result['schema']}))
