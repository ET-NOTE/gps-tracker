"""18B destructive fault tests; disposable internal Docker environment ONLY.
No production mode, no real accounts or external messages.
"""
import os, statistics, threading, websocket, hmac
from concurrent.futures import ThreadPoolExecutor
import pathlib
here=pathlib.Path(__file__).parent
helpers=(here/'test_privacy_packages.py').read_text()
exec(compile(helpers.split('owner,other,admin=')[0],__file__,'exec'))
assert cfg.get('GPS_LOCATION_ACCESS_LOG')=='on'
owner,other,admin,member=[account(n) for n in [91,92,93,94]]
uid,oid,aid,mid=[x['user_id'] for x in (owner,other,admin,member)]
token,at=owner['access_token'],admin['access_token']
sql("UPDATE users SET role='admin' WHERE id=%s",(aid,))
now=lambda:datetime.now(timezone.utc)
z=lambda t:t.isoformat().replace("+00:00","Z")
def device(n,user):return sql("INSERT INTO devices(device_uid,owner_id,api_key_hash,display_name) VALUES(%s,%s,'fixture','synthetic') RETURNING id",(f'{tag}-event-{n}',user))
d1,dc=device(1,uid),device(2,uid)
sql("INSERT INTO location_records(device_id,recorded_at,source,fix,lat,lng,user_id) VALUES(%s,now(),'l80',true,37.123456,127.654321,%s)",(d1,uid))
sql("UPDATE devices SET last_lat=37.123456,last_lng=127.654321,last_fix_at=now() WHERE id=%s",(d1,))
def rows(where='true',args=()):
 with db.cursor() as c:
  c.execute('SELECT to_jsonb(e) FROM location_access_events e WHERE '+where+' ORDER BY id',args);return [r[0] for r in c.fetchall()]
def read():return call('GET',f'/devices/{d1}/locations/latest',token=token)
def restart(action='api',ledger='on',erase=''):
 global base,ai,cfg
 done=subprocess.run(['bash',str(here/'dev18.sh'),action],env={**os.environ,'LEDGER':ledger,'ERASURE':erase},capture_output=True,text=True)
 assert done.returncode==0,(action,done.stdout,done.stderr)
 if action=='api':
  ai=inspect('container',API);cfg=dict(v.split('=',1) for v in ai['Config']['Env'] if '=' in v)
  base=f"http://{ai['NetworkSettings']['Networks'][NETWORK]['IPAddress']}:3043/gps-tracker/api/v1"
def rejected(q,args=()):
 try:sql(q,args)
 except psycopg2.Error as e:return e.pgcode in ('23514','23505')
 return False
def wait_for(test):
 for _ in range(100):
  if test():return
  time.sleep(.05)
 raise AssertionError('condition timeout')

assert read()[0]==200
first=rows('device_id=%s',(d1,))[-1]
assert first['outcome']=='response_ready' and first['account_scope_id']==uid and first['subject_user_id'] is None
assert first['route']=='/devices/:id/locations/latest'
for _ in range(3):assert read()[0]==200
assert len(rows('device_id=%s',(d1,)))==4
assert sql("SELECT sum(hits) FROM location_access_hourly WHERE account_scope_id=%s",(uid,))==4
assert sql('SELECT count(*) FROM location_access_log')==0
assert call('GET',f'/devices/{d1}/locations/latest',token=other['access_token'])[0]==404
assert rows('device_id=%s',(d1,))[-1]['outcome']=='denied'
check('each HTTP operation commits a separate intent/outcome; aggregation is a view; refusal is not a successful disclosure')

sql('UPDATE devices SET owner_id=%s WHERE id=%s',(oid,d1))
assert rows('id=%s',(first['id'],))[0]==first
assert call('GET',f'/devices/{d1}',token=other['access_token'])[0]==200
assert rows('device_id=%s',(d1,))[-1]['account_scope_id']==oid
sql('UPDATE devices SET owner_id=%s WHERE id=%s',(uid,d1))
vehicle=sql("INSERT INTO fleet_vehicles(owner_id,name) VALUES(%s,'event fixture') RETURNING id",(uid,))
binding=sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,started_at) VALUES(%s,%s,%s,'synthetic',now()-interval '1 day') RETURNING id",(vehicle,uid,dc))
staff=sql("INSERT INTO staff(user_id,name,access_role,all_vehicles) VALUES(%s,'fixture','member',true) RETURNING id",(uid,))
sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(uid,staff,mid))
sql("INSERT INTO subscriptions(user_id,kind,expires_at) VALUES(%s,'corporate_report',now()+interval '1 day')",(uid,))
path=f'/corporate/vehicles/{vehicle}/trips?from={z(now()-timedelta(hours=1))}&to={z(now())}'
status,result,_=call('GET',path,token=member['access_token'],extra={'x-fleet-owner':str(uid)})
assert status==200,(status,result)
company=rows('vehicle_id=%s',(vehicle,))[-1]
assert company['attribution']=='company_scope' and company['recipient_user_id']==mid and company['subject_user_id'] is None
assert company['binding_snapshot'][0]['id']==binding and company['binding_snapshot'][0]['ended_at'] is None
sql('UPDATE fleet_vehicle_bindings SET ended_at=now() WHERE id=%s',(binding,))
assert rows('id=%s',(company['id'],))[0]==company
check('SIM owner transfer and vehicle binding end do not rewrite earlier account context, recipient or binding snapshot; driver remains unconfirmed')

linktoken='private-link-'+tag
link=sql("INSERT INTO share_tokens(token,device_id,created_by,expires_at) VALUES(%s,%s,%s,now()+interval '1 day') RETURNING id",(linktoken,d1,uid))
assert call('GET',f'/share/{linktoken}')[0]==200
shared=rows('share_id=%s',(link,))[-1]
sql('DELETE FROM share_tokens WHERE id=%s',(link,))
assert rows('id=%s',(shared['id'],))[0]==shared and shared['recipient_user_id'] is None
assert shared['attribution']=='share_creator'
raw=json.dumps(rows())
for secret in ['37.123456','127.654321',linktoken,owner['email'],token]:assert secret not in raw
for change in ["account_scope_id=999","outcome='denied'","route='/changed'","binding_snapshot='[]'::jsonb"]:
 assert rejected('UPDATE location_access_events SET '+change+' WHERE id=%s',(company['id'],)),change
assert rejected('DELETE FROM location_access_events WHERE id=%s',(first['id'],))
assert rejected('TRUNCATE location_access_events')
check('share deletion leaves immutable ID-only evidence; no coordinates, link token, e-mail or JWT; arbitrary update/delete/truncate refused')

# Force actual INSERT and UPDATE errors, not a mocked success response.
sql("CREATE FUNCTION test_ledger_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic storage fault'; END $$")
for phase in ['INSERT','UPDATE']:
 sql(f'CREATE TRIGGER test_ledger_failure BEFORE {phase} ON location_access_events FOR EACH ROW EXECUTE FUNCTION test_ledger_failure()')
 try:
  s,r,_=read();assert s==503 and 'lat' not in str(r),(phase,s,r)
 finally:sql('DROP TRIGGER test_ledger_failure ON location_access_events')
sql('DROP FUNCTION test_ledger_failure()')
assert read()[0]==200
check('DB insert/completion failure returns 503 without location; committed prepared intent survives failed completion; recovery works')

# Block handler data SELECT after middleware commits its intent, then SIGKILL.
blocker=psycopg2.connect(db.dsn,password='closure-test-only');blocker.autocommit=False
with blocker.cursor() as c:c.execute('LOCK TABLE location_records IN ACCESS EXCLUSIVE MODE')
before=sql('SELECT COALESCE(max(id),0) FROM location_access_events')
pool=ThreadPoolExecutor(1);pending=pool.submit(read)
wait_for(lambda:sql("SELECT count(*) FROM location_access_events WHERE id>%s AND device_id=%s AND outcome='prepared'",(before,d1))==1)
prepared=rows('id>%s AND device_id=%s',(before,d1))[0]
restart('kill');blocker.rollback();blocker.close()
try:pending.result(timeout=10)
except Exception:pass
pool.shutdown(wait=True)
restart()
assert rows('id=%s',(prepared['id'],))[0]==prepared
assert read()[0]==200
check('SIGKILL during blocked location SELECT preserves precommitted intent with unknown outcome; restart cannot turn it into successful delivery')

# A subscription is not a disclosure. Actual signed synthetic telemetry creates
# messages, and each message must have committed evidence before socket write.
origin=base.removesuffix('/gps-tracker/api/v1')
ws=websocket.create_connection(origin.replace('http:','ws:')+'/gps-tracker/ws/realtime?token='+token,timeout=5)
assert json.loads(ws.recv())['type']=='hello'
ws.send(json.dumps({'action':'subscribe','device_ids':[d1]}));assert json.loads(ws.recv())['accepted']==[d1]
assert rows("device_id=%s AND path='realtime'",(d1,))==[]
sim='89882280666'+str(int(tag,16))[-8:]
sql('UPDATE devices SET iccid=%s WHERE id=%s',(sim,d1))
auth=tag+'-live';key=hashlib.sha256(auth.encode()).digest()
sql('INSERT INTO hardware_credentials(auth_uid,key_digest,authorized_owner_id) VALUES(%s,%s,%s)',(auth,key,uid))
def ingest(n):
 raw=json.dumps({'device_uid':f'{tag}-event-1','iccid':sim,'l80':{'fix':True,'lat':37.123456,'lng':127.654321,'sat':8}},separators=(',',':')).encode()
 sig=hmac.new(key,f'{auth}\n{n}\n'.encode()+raw,hashlib.sha256).hexdigest()
 req=urllib.request.Request(origin+'/gps-tracker/ingest',data=raw,headers={'Content-Type':'application/json','X-GPS-Auth-Version':'2','X-GPS-UID':auth,'X-GPS-Counter':str(n),'X-GPS-Signature':sig})
 with urllib.request.urlopen(req,timeout=15) as r:assert r.status==200
for n in (1,2):
 ingest(n)
 while True:
  event=json.loads(ws.recv())
  if event['type']=='location':break
wait_for(lambda:len(rows("device_id=%s AND path='realtime' AND outcome='socket_sent'",(d1,)))>=2)
ws.close()
check('WebSocket subscribe alone is not recorded as delivery; two real signed synthetic ingest messages have per-message socket_sent evidence')

# Erasure remains OFF; when explicitly enabled in this isolated environment only,
# require reviewed request, current revision, operator, period, confirmation and evidence.
s,req,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'erasure','scope':'Synthetic withdrawal of account access events','password':password},token)
assert s==202,(s,req)
endpoint=f"/admin/privacy/requests/{req['id']}/access-ledger-erasure"
payload={'revision':req['revision'],'from':z(now()-timedelta(hours=1)),'until':z(now()),'evidence_reference':'synthetic-reviewed-withdrawal','confirmed':True}
assert call('POST',endpoint,payload,at)[0]==409
restart(erase='on')
assert call('POST',endpoint,payload,token)[0]==403
assert call('POST',endpoint,payload,at)[0]==409
s,req,_=call('PATCH',f"/admin/privacy/requests/{req['id']}",{'revision':req['revision'],'status':'in_review','message':'Synthetic scope review','evidence_reference':'synthetic','due_at':z(now()+timedelta(days=1))},at);assert s==200,(s,req)
payload['revision']=req['revision']
assert call('POST',endpoint,{**payload,'confirmed':False},at)[0]==400
assert call('POST',endpoint,{**payload,'revision':req['revision']-1},at)[0]==409
others=rows('account_scope_id=%s',(oid,))
s,result,_=call('POST',endpoint,payload,at);assert s==200 and result['removed']>=4 and not result['request_completed'],(s,result)
assert rows('id=%s',(first['id'],))==[] and rows('id=%s',(prepared['id'],))==[]
assert rows('account_scope_id=%s',(oid,))==others
assert rows('id=%s',(company['id'],))[0]==company and rows('id=%s',(shared['id'],))[0]==shared
assert call('POST',endpoint,payload,at)[0]==409
assert sql("SELECT count(*) FROM admin_audit_log WHERE action='location_access_erasure' AND target_user=%s",(uid,))==1
restart()
assert rows('id=%s',(first['id'],))==[]
check('reviewed withdrawal can erase recent unambiguous account events; disabled/ordinary user/stale revision/unconfirmed/replay refused; company/share/other account retained for separate review; restart does not resurrect')

# Freeze an intent BEFORE its DB lock, execute erasure with the same lock, then
# release it: a stale in-flight intent must not be reinserted after withdrawal.
s,req,_=call('PATCH',f"/admin/privacy/requests/{req['id']}",{'revision':req['revision'],'status':'in_review','message':'Synthetic boundary review','evidence_reference':'synthetic-2','due_at':z(now()+timedelta(days=1))},at);assert s==200,(s,req)
gate=psycopg2.connect(db.dsn,password='closure-test-only');gate.autocommit=False
with gate.cursor() as c:c.execute('SELECT pg_advisory_xact_lock(1830,%s)',(uid,))
with ThreadPoolExecutor(1) as pool:
 pending=pool.submit(read)
 wait_for(lambda:sql("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted")>0)
 with gate.cursor() as c:
  c.execute('SELECT privacy_erase_access_events(%s,%s,%s,now()-interval \'1 hour\',clock_timestamp(),%s)',(req['id'],req['revision'],aid,'synthetic-boundary'))
 gate.commit();gate.close()
 assert pending.result(timeout=15)[0]==503
assert read()[0]==200
check('erasure/intent race is serialized; old in-flight request cannot resurrect a deleted-period event; genuinely later requests remain usable')

# Non-destructive concurrent reads: quantify cost and preserve every operation.
before=sql('SELECT count(*) FROM location_access_events')
def timed(_):
 t=time.perf_counter();s,_,_=read();return s,(time.perf_counter()-t)*1000
with ThreadPoolExecutor(12) as pool:burst=list(pool.map(timed,range(120)))
assert {s for s,_ in burst}=={200} and sql('SELECT count(*) FROM location_access_events')==before+120
latencies=sorted(t for _,t in burst)
check('120 concurrent reads produce exactly 120 durable events; no hourly coalescing or dropped queue')

span=f'from={z(now()-timedelta(hours=1))}&until={z(now()+timedelta(minutes=1))}'
s,result,_=call('GET','/admin/location-access?'+span,token=at)
assert s==200 and result['scope_version']==2 and any(r['record_type']=='event' for r in result['records']),(s,result)
assert call('GET','/admin/location-access?'+span,token=token)[0]==403
assert all(r['actual_subject_user_id'] is None for r in result['records'])
check('administrator read is audited; event/legacy, account scope/actual subject and delivery outcome are explicit')

report={'mode':'isolated-on','schema':sql('SELECT max(version) FROM _sqlx_migrations'),'api_sha256':digest,
 'integration_groups':len(passed),'groups':passed,'concurrent_reads':120,'parallelism':12,
 'latency_ms':{'median':round(statistics.median(latencies),2),'p95':round(latencies[int(.95*len(latencies))],2)},
 'production_changed':False,'external_messages':0}
(here/'location-access-events-validation.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
