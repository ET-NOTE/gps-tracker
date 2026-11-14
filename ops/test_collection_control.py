"""Synthetic collection policy integration; isolated Docker only, no production target."""
import base64, concurrent.futures, hashlib, hmac, json, pathlib, subprocess, time, urllib.request, urllib.error, uuid
import psycopg2
NETWORK='gps-account-closure-test-20261105'
DB='gps-account-closure-db-20261105'
API='gps-account-closure-api-20261105'
inspect=lambda kind,name:json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NETWORK)['Internal']
di,ai=inspect('container',DB),inspect('container',API)
cfg=dict(v.split('=',1) for v in ai['Config']['Env'] if '=' in v)
assert cfg['APP_ENV']=='test' and cfg['DATABASE_URL']=='postgres://postgres:closure-test-only@closure-db:5432/gps_closure_test'
binary=pathlib.Path(__file__).parent/'out/gps-tracker-api'
assert subprocess.check_output(['docker','exec',API,'sha256sum','/proc/1/exe']).decode().split()[0]==hashlib.sha256(binary.read_bytes()).hexdigest()
base=f"http://{ai['NetworkSettings']['Networks'][NETWORK]['IPAddress']}:3043"
dsn=f"postgres://postgres:closure-test-only@{di['NetworkSettings']['Networks'][NETWORK]['IPAddress']}/gps_closure_test"
db=psycopg2.connect(dsn);db.autocommit=True
tag=uuid.uuid4().hex[:12];passed=[]
def sql(q,args=(),connection=db):
 with connection.cursor() as c:
  c.execute(q,args);return c.fetchone()[0] if c.description else None
def call(method,path,body=None,token=None):
 h={'Content-Type':'application/json'}
 if token:h['Authorization']='Bearer '+token
 try:
  with urllib.request.urlopen(urllib.request.Request(base+'/gps-tracker/api/v1'+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers=h),timeout=15) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,e.read().decode()
def account(n):
 phone='010'+str(int(tag,16)+n)[-8:]
 status,otp=call('POST','/auth/send-otp',{'phone':phone});assert status==200
 status,row=call('POST','/auth/register',{'email':f'{tag}-{n}@example.invalid','phone':phone,'otp_code':otp['dev_code'],'password':'isolated-collection-Only9!','display_name':'Collection fixture'});assert status==200
 return row
def check(s):passed.append(s);print('PASS '+s,flush=True)
owner,other=account(10),account(11);uid=owner['user_id'];token=owner['access_token']
sim='89882280666'+str(int(tag,16))[-8:]
did=sql("INSERT INTO devices(device_uid,iccid,owner_id,api_key_hash,display_name) VALUES(%s,%s,%s,'fixture','collection fixture') RETURNING id",(tag,sim,uid))
keys={};counters={}
def hardware(suffix):
 auth=tag+suffix;key=hashlib.sha256(auth.encode()).digest();keys[auth]=key;counters[auth]=0
 sql('INSERT INTO hardware_credentials(auth_uid,key_digest,authorized_owner_id) VALUES(%s,%s,%s)',(auth,key,uid));return auth
a,b=hardware('a'),hardware('b')
def ingest(payload,auth=a):
 payload={'device_uid':tag,'iccid':sim,**payload};counters[auth]+=1;n=counters[auth]
 raw=json.dumps(payload,separators=(',',':')).encode();key=keys[auth]
 sig=hmac.new(key,f'{auth}\n{n}\n'.encode()+raw,hashlib.sha256).hexdigest()
 r=urllib.request.Request(base+'/gps-tracker/ingest',data=raw,headers={'Content-Type':'application/json','X-GPS-Auth-Version':'2','X-GPS-UID':auth,'X-GPS-Counter':str(n),'X-GPS-Signature':sig})
 with urllib.request.urlopen(r,timeout=15) as response:ack=json.load(response)
 assert hmac.compare_digest(ack['signature'],hmac.new(key,f"response\n{auth}\n{n}\n{ack['payload']}".encode(),hashlib.sha256).hexdigest())
 return json.loads(base64.b64decode(ack['payload']))
def row():
 status,rows=call('GET','/privacy/collection',token=token);assert status==200
 return next(x for x in rows['items'] if x['device_id']==did)
def change(paused,who=token,epoch=None):return call('POST',f'/privacy/collection/{did}',{'paused':paused,'epoch':epoch or row()['epoch']},who)
def count():return sql('SELECT count(*) FROM location_records WHERE device_id=%s',(did,))
fix={'l80':{'fix':True,'lat':37.1,'lng':127.1,'sat':8}}
def fresh(policy):return {**fix,'collection':{**policy,'uptime_ms':3000,'since_ms':2000,'fix_up_ms':2500},'fixes':[{'lat':37.1,'lng':127.1,'sat':8,'up_ms':2500,'age_ms':500}]}
assert ingest(fix)['stored'];assert count()==1
check('unchanged legacy hardware ingestion before opt-in')
ack=ingest({'collection':{'version':1,'control_only':True}});policy=ack['collection'];assert not ack['stored'] and count()==1
assert not row()['device_applied']
assert ingest(fresh(policy))['stored'];assert row()['device_applied'];before=count()
check('authenticated first handshake / SIM epoch / device application acknowledgement')
assert change(True,other['access_token'])[0]==404
assert change(True,epoch=str(uuid.uuid4()))[0]==409
assert not row()['paused']
check('owner authorization / stale setting conflict')
# Pause waits for the same advisory gate held throughout authenticated ingestion.
tx=psycopg2.connect(dsn);sql('SELECT pg_advisory_xact_lock(%s)',(did,),tx)
with concurrent.futures.ThreadPoolExecutor() as pool:
 pending=pool.submit(change,True);time.sleep(.3);assert not pending.done();tx.commit();assert pending.result()[0]==200
tx.close();assert row()['paused'] and not row()['device_applied']
assert not ingest(fresh(policy))['stored'];assert count()==before
paused=ingest({'collection':{'version':1,'control_only':True}})['collection'];assert paused['paused']
assert not ingest({'collection':{**paused,'control_only':True}})['stored'];assert row()['device_applied']
check('pause serialized with ingest / old packet dropped / MCU pause acknowledgement')
for q,args in [("INSERT INTO location_records(device_id,recorded_at,source,fix) VALUES(%s,now(),'l80',false)",(did,)),("UPDATE devices SET last_lat=38,last_fix_at=now() WHERE id=%s",(did,))]:
 try:sql(q,args)
 except psycopg2.Error as e:assert e.pgcode=='55000'
 else:raise AssertionError('pause DB barrier bypass')
check('direct late location insert and coordinate cache writer blocked')
assert ingest({'collection':{'version':1}},b)['collection']['paused'];assert not row()['device_applied']
assert not ingest({'collection':{**paused,'control_only':True}},b)['stored'];assert row()['device_applied']
assert sql('SELECT active_auth_uid FROM devices WHERE id=%s',(did,))==b
check('SIM moved to independently authenticated hardware retains pause and re-acknowledges')
assert change(False)[0]==200;assert not row()['device_applied']
assert not ingest(fix,b)['stored'] # Legacy cannot silently undo an enforced pause.
assert not ingest(fresh(paused),b)['stored']
resume=ingest({'collection':{'version':1,'control_only':True}},b)['collection'];assert not resume['paused']
stale=fresh(resume);stale['fixes'][0]['up_ms']=1500;stale['fixes'][0]['age_ms']=1500
assert not ingest(stale,b)['stored'] and count()==before
new=fresh(resume);new['collection'].update(uptime_ms=5000,since_ms=4000,fix_up_ms=4500);new['fixes'][0]['up_ms']=4500
response=ingest(new,b)
assert response['stored'] and count()==before+1,(response,count(),before)
check('resume rejects missing/old epochs and relabelled pre-boundary batch; fresh data accepted')
assert change(False)[0]==200
assert sql('SELECT count(*) FROM collection_control_events WHERE device_id=%s',(did,))==2
check('unchanged setting is idempotent; pause/resume audit preserved')
# Server restart retains persistent policy. No local desired-state cache is used.
assert change(True)[0]==200
subprocess.run(['docker','restart',API],check=True,stdout=subprocess.DEVNULL)
for _ in range(30):
 try:
  with urllib.request.urlopen(base+'/gps-tracker/health',timeout=2) as r:
   if json.load(r)['db']:break
 except (urllib.error.URLError,TimeoutError):time.sleep(1)
assert row()['paused'] and not ingest(fresh(resume),b)['stored']
check('server restart retains SIM pause')
sql('UPDATE device_data_controls SET blocked=true WHERE device_id=%s',(did,))
assert change(False)[0]==409
assert ingest({'collection':{'version':1}},b)['collection']['paused']
check('erasure restriction dominates user resume')
report={'groups':passed,'schema':sql('SELECT max(version) FROM _sqlx_migrations'),'api_sha256':hashlib.sha256(binary.read_bytes()).hexdigest()}
(pathlib.Path(__file__).parent/'collection-validation.json').write_text(json.dumps(report,indent=2))
print(json.dumps({'groups_passed':len(passed),'schema':report['schema']}))
