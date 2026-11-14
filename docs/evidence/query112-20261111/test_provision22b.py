"""Synthetic offline conversion and live API regression. Internal Docker only."""
import base64, hashlib, json, os, pathlib, subprocess, urllib.request, urllib.error, uuid
import psycopg



HERE=pathlib.Path(__file__).resolve().parent
NET='gps-provision22-test-20261111cumulative112';DB='gps-provision22-db-20261111cumulative112';API='gps-provision22-api-20261111cumulative112'
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
u=owner['user_id'];s=driver['user_id'];s2=driver2['user_id'];token=owner['access_token'];dtoken=driver['access_token'];d2token=driver2['access_token']
start=datetime.now(timezone.utc).replace(microsecond=0)-timedelta(hours=2)
a_end=start+timedelta(minutes=10);b_start=start+timedelta(minutes=15);end=start+timedelta(minutes=25)
did=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,%s,'') RETURNING id",(u,'projection-'+tag))
v=sql("INSERT INTO fleet_vehicles(owner_id,name,license_plate) VALUES(%s,'정보주체 검증 차량','합성22B') RETURNING id",(u,))
bind=sql("INSERT INTO fleet_vehicle_bindings(owner_id,vehicle_id,device_id,terminal_name,started_at,is_primary) VALUES(%s,%s,%s,'SIM fixture',%s,true) RETURNING id",(u,v,did,start-timedelta(days=1)))
sql("INSERT INTO subscriptions(user_id,kind,expires_at) VALUES(%s,'corporate_report',now()+interval '1 day')",(u,))
def member(who):
 sid=sql("INSERT INTO staff(user_id,name,active,access_role,all_vehicles) VALUES(%s,'합성 직원',true,'member',false) RETURNING id",(u,))
 sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(u,sid,who));return sid
sid=member(s);sid2=member(s2)
sql('INSERT INTO fleet_staff_vehicles(owner_id,staff_id,vehicle_id) VALUES(%s,%s,%s)',(u,sid,v))
sql("UPDATE location_subject_policy SET enabled=true,reference='isolated-22b',push_enabled=false")
subprocess.run(['bash',str(HERE/'dev22.sh'),'api'],env=dict(os.environ,LEDGER='on',SUBJECTS='on'),check=True)
def mapping(staff,at,until,who):
 code,m=request('POST','/corporate/subject-mappings',{'request_key':str(uuid.uuid4()),'staff_id':staff,'binding_id':bind,'starts_at':at.isoformat(),'ends_at':until.isoformat()},token);assert code==200,(code,m)
 code,r=request('POST',f"/privacy/subject-mappings/{m['id']}/decision",{'action':'confirmed','revision':0,'consent_version':'fleet-subject-v1'},who);assert code==200,(code,r);return m['id']
m1=mapping(sid,start,a_end,dtoken);m2=mapping(sid2,b_start,end,d2token)
for base_at in [start,b_start]:
 for kind,minute in [('wake',1),('sleep_enter',8)]:sql('INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,%s,%s)',(did,u,kind,base_at+timedelta(minutes=minute)))
 for minute in [1,2,4,6,8]:sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',%s,%s,127,true)",(did,u,base_at+timedelta(minutes=minute),37+minute*.0001))
for at in [start-timedelta(minutes=1),a_end,end,end+timedelta(minutes=1)]:sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',%s,38.88888,128.88888,true)",(did,u,at))
sql('UPDATE devices SET last_lat=38.88888,last_lng=128.88888,last_fix_at=%s WHERE id=%s',(end+timedelta(minutes=1),did))
period=urlencode({'from':(start-timedelta(minutes=2)).isoformat(),'to':(end+timedelta(minutes=2)).isoformat()})
root=f'/corporate/vehicles/{v}/trips'
def get(path,who=token,headers=None):
 code,r=request('GET',path,token=who,headers=headers);assert code==200,(path,code,str(r)[:300]);return r
def notices():return sql('SELECT count(*) FROM location_provision_notices WHERE owner_id=%s',(u,))
rows=get('/corporate/terminals');r=next(r for r in rows if r['id']==did)
assert abs(r['last_lat']-37.0008)<.000001 and r['subject_scope']=='confirmed-subject-intervals',r
assert notices()==1 and sql('SELECT mapping_id FROM location_provision_notices WHERE owner_id=%s ORDER BY id DESC LIMIT 1',(u,))==m2
trips=get(root+'?'+period);assert len(trips)==2,trips
assert {t['quality']['subject_mapping_id'] for t in trips}=={m1,m2}
assert all(t['start_lat']<38 and t['end_lat']<38 for t in trips)
assert notices()==3
before=notices()
assert request('HEAD',root+'?'+period,token=token)[0]==405
assert notices()==before
ok('existing map ignores cached/unconfirmed positions; trips split at two confirmed subjects; notices match returned mappings')
for path in [f'/corporate/devices/{did}/trips?'+period,root+'?'+period+'&download=csv',root+'?'+period+'&download=pdf']:
 assert len(get(path))==2
assert sql("SELECT count(*) FROM location_access_events WHERE account_scope_id=%s AND method='file' AND outcome='response_ready'",(u,))==2
csv=get(f'/corporate/devices/{did}/trips.csv?'+period).decode('utf-8-sig');assert '38.88888' not in csv and '정보주체' in csv
for path in ['/corporate/vehicle-stats','/corporate/fleet/trip-stats?'+period]:
 result=get(path);assert result['basis']=='confirmed_subject_intervals',result
 assert sum(x['fix_count'] for x in result['per_device'])==10,result
 assert sum(x['total_distance_m'] for x in result['per_device'])<1000,result
import io,zipfile
month=(start+timedelta(hours=9)).strftime('%Y-%m')
for scope in ['', '&scope=vehicles']:
 blob=get('/corporate/report.xlsx?month='+month+scope)
 with zipfile.ZipFile(io.BytesIO(blob)) as z:
  text=z.read('xl/sharedStrings.xml').decode();assert '정보주체' in text and '38.88888' not in text and '합성22B' in text
ok('legacy and vehicle reports, CSV, browser-export intents, monthly point stats and both XLSX scope modes obey the same projection')
# Existing correction crossing an unconfirmed gap cannot reintroduce its output or notes.
secret='EXCLUDED-CORRECTION-22B'
sql("INSERT INTO fleet_trip_corrections(owner_id,vehicle_id,source_device_id,binding_id,started_at,ended_at,action,reason,sources,outputs,evidence_hash,actor_id) VALUES(%s,%s,%s,%s,%s,%s,'merge','합성 격리 시험','[]',%s,'untrusted',%s)",(u,v,did,bind,start,end,json.dumps([{'started_at':start.isoformat(),'ended_at':end.isoformat(),'start_address':secret,'quality':{}}]),u))
assert secret not in json.dumps(get(root+'?'+period))
assert 'correction_id' not in json.dumps(get(root+'?'+period))
ok('cross-subject/gap correction overlay cannot reintroduce excluded evidence')
# No mapping on the requested period means no location, not a fabricated stationary day.
n=notices();empty=urlencode({'from':(end+timedelta(minutes=1)).isoformat(),'to':(end+timedelta(minutes=2)).isoformat()})
assert get(root+'?'+empty)==[] and notices()==n
assert request('GET',root+'?'+period,token=other['access_token'])[0]==404
assert request('GET',root+'?'+period,token=d2token,headers={'X-Fleet-Owner':str(u)})[0]==404
n=notices();get(root+'?'+period,dtoken,{'X-Fleet-Owner':str(u)});assert notices()==n+1
assert sql('SELECT subject_id FROM location_provision_notices WHERE owner_id=%s ORDER BY id DESC LIMIT 1',(u,))==s2
ok('empty period emits no notice; outsider/unassigned member denied; self interval is not third-party provision')
# Pause one subject: unrelated confirmed subject continues with no copied legacy daily totals.
assert request('POST','/privacy/processing',{'use_paused':False,'provision_paused':True,'revision':0},dtoken)[0]==200
n=notices();remaining=get(root+'?'+period);assert len(remaining)==1 and remaining[0]['quality']['subject_mapping_id']==m2 and notices()==n+1
assert request('POST',f'/privacy/subject-mappings/{m2}/decision',{'action':'revoked','revision':1,'consent_version':'fleet-subject-v1'},d2token)[0]==200
n=notices();assert get(root+'?'+period)==[] and notices()==n
assert next(r for r in get('/corporate/terminals') if r['id']==did)['last_lat'] is None
assert get('/corporate/vehicle-stats')['per_device']==[]
ok('subject pause filters only that subject; revoked final interval removes map/trips/stats without zero-km fallback')
# Re-enable first subject, then fail notice persistence: response body must be withheld.
assert request('POST','/privacy/processing',{'use_paused':False,'provision_paused':False,'revision':1},dtoken)[0]==200
sql("CREATE FUNCTION public.fail22b_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic notice failure'; END $$")
sql('CREATE TRIGGER fail22b_notice BEFORE INSERT ON location_provision_notices FOR EACH ROW EXECUTE FUNCTION fail22b_notice()')
n=notices();code,r=request('GET',root+'?'+period,token=token);assert code==503 and '37.000' not in json.dumps(r) and notices()==n,(code,r)
sql('DROP TRIGGER fail22b_notice ON location_provision_notices');sql('DROP FUNCTION public.fail22b_notice()')
get(root+'?'+period)
ok('notice storage failure discards the prepared response; recovery resumes durable notices')
# SIM identity remains stable across authentication hardware replacement.
sql("UPDATE devices SET active_auth_uid='22b-new-hardware' WHERE id=%s",(did,))
assert len(get(root+'?'+period))==1
# Pause the reader after its initial authorization, then change the binding.
# Its already prepared body must not survive the final authorization check.
import concurrent.futures,time
n=notices()
with psycopg.connect(dsn) as lock:
 lock.execute('LOCK TABLE location_records IN ACCESS EXCLUSIVE MODE')
 with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
  reading=executor.submit(request,'GET',root+'?'+period,None,token)
  waiting=False
  for _ in range(100):
   waiting=sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE %s AND pid<>pg_backend_pid())",('%location_points_between%',))
   if waiting:break
   time.sleep(.05)
  assert waiting,'reader did not reach its point lookup'
  sql('UPDATE fleet_vehicle_bindings SET ended_at=%s WHERE id=%s',(start+timedelta(seconds=30),bind))
  lock.commit()
  code,body=reading.result(timeout=30)
  assert code==503 and '37.000' not in json.dumps(body) and notices()==n,(code,body)
n=notices();assert get(root+'?'+period)==[] and notices()==n
assert sql('SELECT device_id FROM location_subject_mappings WHERE id=%s',(m1,))==did
ok('hardware auth replacement keeps SIM history; changed binding clips coverage and cannot restore excluded location')
result={'suite':'22B company readers','passed':passed,'schema':sql('SELECT max(version) FROM _sqlx_migrations'),'api_sha256':digest,'encrypted':os.environ.get('STORAGE')=='pilot','fixture':{'owner':u,'device':did},'production_modified':False,'external_messages':0}
(HERE/('out/round22b-encrypted.json' if os.environ.get('STORAGE')=='pilot' else 'out/round22b-integration.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps({'passed':len(passed),'schema':result['schema']}))
