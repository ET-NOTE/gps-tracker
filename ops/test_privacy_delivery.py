"""No production mode: real API/DB workflow in an internal Docker network only."""
import concurrent.futures,csv,hashlib,io,json,pathlib,subprocess,time,urllib.error,urllib.request,uuid
from datetime import datetime,timedelta,timezone
import psycopg2

NETWORK='gps-account-closure-test-20261105';DB='gps-account-closure-db-20261105';API='gps-account-closure-api-20261105'
inspect=lambda kind,name:json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NETWORK)['Internal']
di,ai=inspect('container',DB),inspect('container',API)
cfg=dict(v.split('=',1) for v in ai['Config']['Env'] if '=' in v)
assert cfg['APP_ENV']=='test' and cfg['DATABASE_URL']=='postgres://postgres:closure-test-only@closure-db:5432/gps_closure_test'
binary=pathlib.Path(__file__).parent/'out/gps-tracker-api';digest=hashlib.sha256(binary.read_bytes()).hexdigest()
assert subprocess.check_output(['docker','exec',API,'sha256sum','/proc/1/exe']).decode().split()[0]==digest
base=f"http://{ai['NetworkSettings']['Networks'][NETWORK]['IPAddress']}:3043/gps-tracker/api/v1"
db=psycopg2.connect(f"postgres://postgres:closure-test-only@{di['NetworkSettings']['Networks'][NETWORK]['IPAddress']}/gps_closure_test");db.autocommit=True
tag=uuid.uuid4().hex[:12];password='delivery-fixture-only-9!';passed=[]
def sql(q,args=()):
 with db.cursor() as c:
  c.execute(q,args);return c.fetchone()[0] if c.description else None
def call(method,path,body=None,token=None,extra=None):
 h={'Content-Type':'application/json',**(extra or {})}
 if token:h['Authorization']='Bearer '+token
 try:r=urllib.request.urlopen(urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers=h),timeout=20)
 except urllib.error.HTTPError as e:r=e
 with r:
  data=r.read();return r.status,json.loads(data) if 'application/json' in r.headers.get('content-type','') else data,r.headers
def check(s):passed.append(s);print('PASS '+s,flush=True)
def account(n):
 email=f'{tag}-{n}@example.invalid';phone='010'+str(int(tag,16)+n)[-8:]
 s,otp,_=call('POST','/auth/send-otp',{'phone':phone});assert s==200
 s,row,_=call('POST','/auth/register',{'email':email,'phone':phone,'otp_code':otp['dev_code'],'password':password,'display_name':'delivery fixture'});assert s==200,(s,row)
 row['email']=email;return row
owner,other,admin=[account(n) for n in [31,32,33]];uid=owner['user_id'];token=owner['access_token'];at=admin['access_token']
sql("UPDATE users SET role='admin' WHERE id=%s",(admin['user_id'],))
def device(n,user):return sql("INSERT INTO devices(device_uid,owner_id,api_key_hash,display_name) VALUES(%s,%s,'fixture','=unsafe-name') RETURNING id",(f'{tag}-sim-{n}',user))
d1=device(1,uid);d2=device(2,other['user_id']);dc=device(3,uid)
start=datetime.now(timezone.utc)-timedelta(days=2);end=start+timedelta(days=1)
for i,(did,user,fix,lat) in enumerate([(d1,uid,True,37.1),(d1,uid,False,88),(d1,other['user_id'],True,38.9),(d1,None,True,39.9),(d2,uid,True,37.2),(dc,uid,True,36.9)]):
 sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,raw) VALUES(%s,%s,%s,'l80',%s,%s,127,'{\"secret\":\"must-not-export\"}')",(did,user,start+timedelta(minutes=i+1),fix,lat))
vehicle=sql("INSERT INTO fleet_vehicles(owner_id,name) VALUES(%s,'company fixture') RETURNING id",(uid,))
sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,started_at) VALUES(%s,%s,%s,'business',%s)",(vehicle,uid,dc,start))
def intake(kind='access'):
 s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':kind,'scope':'Synthetic personal location scope','password':password},token);assert s==202,(s,r);return r
def detail(r):return call('GET',f"/admin/privacy/requests/{r['id']}",token=at)[1]['request']
def review(r):
 s,r,_=call('PATCH',f"/admin/privacy/requests/{r['id']}",{'revision':r['revision'],'status':'in_review','message':'Scope reviewed','evidence_reference':'INTERNAL-NOT-FOR-SUBJECT','due_at':(end+timedelta(days=4)).isoformat()},at);assert s==200,(s,r);return r
def grant(r,devices=None):
 r=detail(r);body={'revision':r['revision'],'device_ids':devices or [d1,d2],'from_at':start.isoformat(),'until_at':end.isoformat(),'confirmed':True}
 return call('POST',f"/admin/privacy/requests/{r['id']}/deliveries",body,at)
def dl(g,who=token,pw=password,extra=None):return call('POST',f"/privacy/deliveries/{g['id']}/download",{'password':pw},who,extra)
r=intake();assert grant(r)[0]==409;r=review(r)
s,opts,_=call('GET',f"/admin/privacy/requests/{r['id']}/delivery-options",token=at);assert s==200 and {x['id'] for x in opts['items']}=={d1,d2}
assert grant(r,[dc])[0]==409
s,g,_=grant(r);assert s==200,(s,g)
assert call('POST',f"/admin/privacy/deliveries/{g['id']}/revoke",{},token)[0]==403
assert dl(g,None)[0]==401 and dl(g,other['access_token'])[0]==404
assert dl(g,pw='wrong')[0]==401
assert dl(g,extra={'X-Fleet-Owner':str(uid)})[0]==403
check('review gate, company exclusion, owner/admin/delegated scope and password step-up')
s,data,headers=dl(g);assert s==200,(s,data);assert headers['Cache-Control']=='no-store, private' and headers['X-Content-Type-Options']=='nosniff'
rows=list(csv.reader(io.StringIO(data.decode('utf-8-sig'))));assert len(rows)==4,rows
assert {x[0] for x in rows[1:]}=={str(d1),str(d2)}
assert rows[2][-2:]==['',''] and b'must-not-export' not in data and b'unsafe-name' not in data and b'38.9' not in data and b'39.9' not in data
assert sql("SELECT sha256 FROM privacy_delivery_events WHERE delivery_id=%s AND action='download_prepared' ORDER BY id DESC LIMIT 1",(g['id'],))==hashlib.sha256(data).hexdigest()
assert sql('SELECT owner_id FROM devices WHERE id=%s',(d2,))==other['user_id']
check('CSV exact receipt-owner scope includes detached SIM history; raw/foreign/NULL/stale coordinates excluded; checksum audit')
# The only parent record lies after the requested period. Its batch contains
# two in-period samples and one excluded end-boundary sample.
dbatch=device(4,uid)
sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,fixes_jsonb) VALUES(%s,%s,%s,'l80',true,37.9,127,%s::jsonb)",(dbatch,uid,end+timedelta(seconds=5),json.dumps([{'at_ms':-25000,'lat':37.7,'lng':127},{'at_ms':-15000,'lat':37.8,'lng':127},{'at_ms':-5000,'lat':37.9,'lng':127}])))
s,batch_grant,_=grant(r,[dbatch]);assert s==200,(s,batch_grant)
s,batch_csv,_=dl(batch_grant);assert s==200
batch_rows=list(csv.reader(io.StringIO(batch_csv.decode('utf-8-sig'))))
assert len(batch_rows)==3 and [x[-2] for x in batch_rows[1:]]==['37.7','37.8'],batch_rows
assert batch_rows[0][1]=='기록 시각(UTC)'
s,g,_=grant(r);assert s==200
check('all batch samples exported with exact time bounds even when parent anchor is outside the period')
assert call('GET',f"/privacy/requests/{r['id']}/deliveries",token=other['access_token'])[1]==[]
assert grant(r)[0]==200 # reissue revokes prior scope
assert dl(g)[0]==410
s,g,_=grant(r);assert s==200
assert call('POST',f"/admin/privacy/deliveries/{g['id']}/revoke",{},at)[0]==200 and dl(g)[0]==410
s,g,_=grant(r);assert s==200
sql("UPDATE privacy_deliveries SET created_at=now()-interval '25 hours',expires_at=now()-interval '1 hour' WHERE id=%s",(g['id'],));assert dl(g)[0]==410
check('cross-account listing, reissue, explicit revocation and expiry')
s,g,_=grant(r);assert s==200
sql('UPDATE device_data_controls SET blocked=true WHERE device_id=%s',(d1,));assert dl(g)[0]==409
sql('UPDATE device_data_controls SET blocked=false WHERE device_id=%s',(d1,))
sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,started_at) VALUES(%s,%s,%s,'late assignment',%s)",(vehicle,uid,d1,start))
assert dl(g)[0]==409
sql('DELETE FROM fleet_vehicle_bindings WHERE device_id=%s',(d1,))
check('erasure gate and newly assigned company scope invalidate outstanding delivery')
# Cap enforcement is a refusal, never an apparently complete truncated CSV.
sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix) SELECT %s,%s,%s::timestamptz+g*interval '1 second','l80',false FROM generate_series(1000,11000) g",(d2,uid,start))
assert dl(g)[0]==409
sql("DELETE FROM location_records WHERE device_id=%s AND recorded_at >= %s",(d2,start+timedelta(seconds=1000)))
check('over-10000-row delivery is rejected without silent truncation')
sql('DELETE FROM privacy_result_limits')
public={'email':owner['email'],'password':password,'request_id':r['id']}
s,visible,h=call('POST','/privacy/result',public);assert s==200 and h['Cache-Control']=='no-store, private'
encoded=json.dumps(visible);assert all(x not in encoded for x in ['INTERNAL-NOT-FOR-SUBJECT','evidence_reference','access_token','actor_id','user_id','password_hash','lat','lng'])
for change in [{'password':'wrong'},{'email':other['email']},{'request_id':999999999}]:assert call('POST','/privacy/result',{**public,**change})[0]==401
check('result-only projection, no credentials/internal evidence/session/telemetry, generic ownership failures')
r=detail(r);assert call('POST',f"/privacy/requests/{r['id']}/cancel",{'revision':r['revision']},token)[0]==200
assert dl(g)[0]==410
check('cancelled request immediately blocks outstanding exports')
closed=intake('account_closure');assert call('POST',f"/admin/privacy/requests/{closed['id']}/close-account",{'revision':closed['revision']},at)[0]==200
s,visible,h=call('POST','/privacy/result',{**public,'request_id':closed['id']});assert s==200 and visible['account_restricted'] and visible['status']=='in_review'
assert call('POST','/auth/login',{'email':owner['email'],'password':password})[0]==409
assert call('GET','/auth/me',token=token)[0]==401 and dl(g)[0]==401
assert call('POST','/auth/refresh',{'refresh_token':owner['refresh_token']})[0]==401
check('closed account sees result only; login/refresh/old JWT/download stay blocked')
subprocess.run(['docker','restart',API],check=True,stdout=subprocess.DEVNULL)
for _ in range(30):
 try:
  if call('POST','/privacy/result',{**public,'request_id':closed['id']})[0]==200:break
 except urllib.error.URLError:pass
 time.sleep(1)
else:raise AssertionError('restart failed')
check('delivery and closure result state survive service restart')
sql('DELETE FROM privacy_result_limits')
with concurrent.futures.ThreadPoolExecutor(max_workers=11) as pool:
 statuses=list(pool.map(lambda _:call('POST','/privacy/result',{**public,'email':owner['email'].upper(),'password':'wrong'})[0],range(11)))
assert statuses.count(401)==10 and statuses.count(429)==1,statuses
assert call('POST','/privacy/result',{**public,'request_id':closed['id']})[0]==429
check('atomic normalized-account rate limit under concurrent requests')
result={'integration_groups':len(passed),'groups':passed,'api_sha256':digest,'schema':sql('SELECT max(version) FROM _sqlx_migrations')}
(pathlib.Path(__file__).parent/'delivery-validation.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
