"""No production mode: real API/DB workflow in an internal Docker network only.

Round 18: the handling ledger (who was given a person's location information, through what, how
and when). Run it twice against the development environment of `dev18.sh`:

  1. with the API as it starts by default (recording off): reads leave nothing, and the facts
     file is exactly what round 17 released;
  2. with LEDGER=on: every kind of recipient is recorded for the right subject, nothing that
     locates a person is stored, rows cannot be changed, the periods of recording are explicit,
     nothing is made up for the time before, retention removes only what is old enough, and the
     cost of recording is measured.

The second run restarts the API container itself (clean stop, kill, retention settings).
"""
import base64,os,pathlib,socket,statistics,subprocess
from concurrent.futures import ThreadPoolExecutor
here=pathlib.Path(__file__).parent
helpers=(here/'test_privacy_packages.py').read_text()
exec(compile(helpers.split('owner,other,admin=')[0],__file__,'exec'))
ON=cfg.get('GPS_LOCATION_ACCESS_LOG')=='on'
owner,other,admin,member=[account(n) for n in [81,82,83,84]]
uid,oid,aid,mid=owner['user_id'],other['user_id'],admin['user_id'],member['user_id'];token=owner['access_token'];at=admin['access_token']
sql("UPDATE users SET role='admin' WHERE id=%s",(aid,))
LAT,LNG,NAME,TOKEN='37.123456','127.654321','private-device-name-'+tag,'tok-secret-'+tag
z=lambda t:t.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
now=lambda:datetime.now(timezone.utc)
def device(n,user):return sql("INSERT INTO devices(device_uid,owner_id,api_key_hash,display_name) VALUES(%s,%s,'fixture',%s) RETURNING id",(f'{tag}-ledger-{n}',user,NAME))
def record(did,user,at):sql("INSERT INTO location_records(device_id,recorded_at,source,fix,lat,lng,user_id) VALUES(%s,%s,'l80',true,%s,%s,%s)",(did,at,LAT,LNG,user))
d1,d2,dc=device(1,uid),device(2,oid),device(3,uid)
for minute in range(1,6):record(d1,uid,now()-timedelta(minutes=30+minute))
sql("UPDATE devices SET last_lat=%s,last_lng=%s,last_fix_at=now() WHERE id=%s",(LAT,LNG,d1))
vehicle=sql("INSERT INTO fleet_vehicles(owner_id,name) VALUES(%s,'ledger company fixture') RETURNING id",(uid,))
sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,started_at) VALUES(%s,%s,%s,'company',now())",(vehicle,uid,dc))
link=sql("INSERT INTO share_tokens(token,device_id,created_by,expires_at) VALUES(%s,%s,%s,now()+interval '1 day') RETURNING id",(TOKEN,d1,uid))
def found(where,args=()):
 with db.cursor() as c:
  c.execute(f"SELECT to_jsonb(g) FROM location_access_log g WHERE {where} ORDER BY g.id",args);return [r[0] for r in c.fetchall()]
def runs():
 with db.cursor() as c:
  c.execute("SELECT to_jsonb(c) FROM location_access_coverage c ORDER BY c.id");return [r[0] for r in c.fetchall()]
def one(**want):
 """The single row of this run's fixture with exactly these values."""
 where=' AND '.join(f"g.{k} IS NULL" if v is None else f"g.{k}=%s" for k,v in want.items())
 hit=found(where,tuple(v for v in want.values() if v is not None));assert len(hit)==1,(want,hit);return hit[0]
def none(**want):
 where=' AND '.join(f"g.{k} IS NULL" if v is None else f"g.{k}=%s" for k,v in want.items())
 assert found(where,tuple(v for v in want.values() if v is not None))==[],want
def flow(session,scope):
 s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'access','scope':scope,'password':password},session['access_token']);assert s==202,(s,r)
 s,r,_=call('PATCH',f"/admin/privacy/requests/{r['id']}",{'revision':r['revision'],'status':'in_review','message':'Review fixture','evidence_reference':'fixture','due_at':(now()+timedelta(days=2)).isoformat()},at);assert s==200,(s,r)
 return r['id']
def facts(rid,session,period):
 """The collection, use and provision facts of that account as its subject downloads them."""
 rev=call('GET',f'/admin/privacy/requests/{rid}',token=at)[1]['request']['revision']
 s,p,_=call('POST',f'/admin/privacy/requests/{rid}/account-packages',{'revision':rev,'confirmed':True,'documents':[],'sections':['location_facts'],'facts_from':period[0].isoformat(),'facts_until':period[1].isoformat()},at);assert s==200,(s,p)
 sql('DELETE FROM privacy_result_limits')
 s,data,_=call('POST',f"/privacy/account-packages/{p['id']}/account",{'password':password},session['access_token']);assert s==200,(s,data)
 return data['additional']['location_facts'],last_body
rid=flow(owner,'Access ledger fixture')
window=lambda:(now()-timedelta(hours=2),now()+timedelta(minutes=1))
RELEASED_NOT_RECORDED=8

if not ON:
 # ---- recording is off unless it is switched on ---------------------------------------------------------
 for path in (f'/devices/{d1}/locations/latest',f'/devices/{d1}','/devices',f'/devices/{d1}/locations/page?since={z(now()-timedelta(hours=1))}&until={z(now())}'):
  assert call('GET',path,token=token)[0]==200,path
 assert call('GET','/admin/devices',token=at)[0]==200 and call('GET',f'/share/{TOKEN}')[0]==200
 time.sleep(3)
 assert sql('SELECT count(*) FROM location_access_coverage')==0 and sql('SELECT count(*) FROM location_access_log')==0
 check('with recording off, reads by the owner, an administrator and a share link leave no record and no period of recording exists')
 f,body=facts(rid,owner,window())
 assert 'access_records' not in f and len(f['not_recorded'])==RELEASED_NOT_RECORDED and any('조회할 때마다의 기록을 남기지 않습니다' in s for s in f['not_recorded'])
 check('with no period of recording, the facts file is what round 17 released: no access records and the eight statements')
 s,r,_=call('GET',f'/admin/location-access?from={z(now()-timedelta(hours=1))}&until={z(now())}',token=at)
 assert s==200 and r['recording_now'] is False and r['recorded_periods']==[] and r['records']==[],(s,r)
 assert call('GET',f'/admin/location-access?from={z(now()-timedelta(hours=1))}&until={z(now())}',token=token)[0]==403
 check('the ledger endpoint is for administrators only and says that nothing is being recorded')
 report={'mode':'off','integration_groups':len(passed),'groups':passed,'api_sha256':digest,'schema':sql('SELECT max(version) FROM _sqlx_migrations')}
 assert report['schema']>=100,report['schema']
 (here/'location-access-off-validation.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
 raise SystemExit(0)

# ---- recording is on ---------------------------------------------------------------------------------------
assert cfg.get('GPS_LOCATION_ACCESS_FLUSH_SECONDS')=='1'
settle=lambda:time.sleep(2.5)                    # the recorder writes every second here
if datetime.now().minute>=45:time.sleep((60-datetime.now().minute)*60+5)   # a row belongs to a clock hour: keep this run inside one
apiip=ai['NetworkSettings']['Networks'][NETWORK]['IPAddress']
def api(action,**env):
 """Stops, kills or starts the API container with the development helper; addresses are read again."""
 global base,apiip
 done=subprocess.run(['bash',str(here/'dev18.sh'),action],env={**os.environ,**env},capture_output=True,text=True);assert done.returncode==0,(action,done.stdout,done.stderr)
 if action=='api':
  apiip=inspect('container',API)['NetworkSettings']['Networks'][NETWORK]['IPAddress'];base=f"http://{apiip}:3043/gps-tracker/api/v1"
 return done.stdout
first=runs()
assert len(first)>=1 and first[-1]['stopped_at'] is None and first[-1]['scope_version']==1 and first[-1]['dropped']==0,first
assert sql('SELECT count(*) FROM location_access_log g WHERE g.first_at<(SELECT min(c.started_at) FROM location_access_coverage c)')==0
check('switching recording on writes the start of the period; no record exists from before the first start')

# ---- the owner's own reads ----------------------------------------------------------------------------------
since,until=now()-timedelta(hours=3),now()-timedelta(hours=1)
assert call('GET',f'/devices/{d1}/locations/latest',token=token)[0]==200
for _ in range(3):assert call('GET',f'/devices/{d1}/locations/page?since={z(since)}&until={z(until)}',token=token)[0]==200
assert call('GET',f'/devices/{d1}/locations/page?since={z(since-timedelta(hours=5))}&until={z(until)}',token=token)[0]==200   # a wider request
assert call('GET','/devices',token=token)[0]==200 and call('GET',f'/devices/{d1}',token=token)[0]==200
tried={path:call('GET',path,token=token)[0] for path in (f'/devices/{d1}/events',f'/devices/{d1}/stats/daily',f'/devices/{d1}/active-dates',f'/devices/{d1}/batch-stats')}
assert call('GET',f'/devices/{d1}/locations/latest',token=other['access_token'])[0]==404        # another account: refused, so not a read
assert call('GET',f'/devices/{d1}/sim',token=token)[0] in (200,400,404,409,502,503)             # not location information
assert call('GET','/auth/me',token=token)[0]==200
settle()
position=one(subject_user_id=uid,device_id=d1,recipient_kind='self',path='api',method='position')
assert position['hits']==2 and position['recipient_user_id']==uid and position['all_subjects'] is False and position['range_from'] is None
track=one(subject_user_id=uid,device_id=d1,recipient_kind='self',method='track')
assert track['hits']==4 and datetime.fromisoformat(track['range_from'])==(since-timedelta(hours=5)).replace(microsecond=0) and datetime.fromisoformat(track['range_until'])==until.replace(microsecond=0),track
assert datetime.fromisoformat(track['bucket'])<=datetime.fromisoformat(track['first_at'])<=datetime.fromisoformat(track['last_at'])<datetime.fromisoformat(track['bucket'])+timedelta(hours=1)
assert one(subject_user_id=uid,device_id=None,recipient_kind='self',method='position')['hits']==1                       # the list of all devices
for path,(method) in ((f'/devices/{d1}/events','events'),(f'/devices/{d1}/stats/daily','stats')):
 if tried[path]==200:one(subject_user_id=uid,device_id=d1,recipient_kind='self',method=method)
answered=sum(1 for path in (f'/devices/{d1}/stats/daily',f'/devices/{d1}/active-dates',f'/devices/{d1}/batch-stats') if tried[path]==200)
if answered:assert one(subject_user_id=uid,device_id=d1,recipient_kind='self',method='stats')['hits']==answered
assert found('g.recipient_user_id=%s',(oid,))==[]
check('the owner\'s reads become one row per hour, device and method with a count, first and last time and the widest period asked for; a refused read and a request that is not location information leave nothing')

# ---- a share link, a company member, an administrator, an administrator signed in as the account ------------
assert call('GET',f'/share/{TOKEN}')[0]==200 and call('GET',f'/share/{TOKEN}/locations')[0]==200
assert call('GET','/share/not-a-link-'+tag)[0]==404
staff=sql("INSERT INTO staff(user_id,name,access_role,all_vehicles) VALUES(%s,'ledger fixture','member',true) RETURNING id",(uid,))
sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(uid,staff,mid))
sql("INSERT INTO subscriptions(user_id,kind,expires_at) VALUES(%s,'corporate_report',now()+interval '1 day')",(uid,))
trips=f'/corporate/vehicles/{vehicle}/trips?from={z(since)}&to={z(now())}'
company={path:call('GET',path,token=member['access_token'],extra={'x-fleet-owner':str(uid)})[0] for path in ('/corporate/vehicle-stats',trips)}
assert company['/corporate/vehicle-stats']==200,company
assert call('GET','/corporate/vehicle-stats',token=token,extra={'x-fleet-owner':str(uid)})[0]==200            # the company owner in the same scope
assert call('GET','/admin/devices',token=at)[0]==200 and call('GET',f'/admin/devices/{d1}',token=at)[0]==200 and call('GET',f'/admin/users/{uid}/devices',token=at)[0]==200
s,acting,_=call('POST',f'/admin/users/{uid}/impersonate',{},at);assert s==200,(s,acting)
before=one(subject_user_id=uid,device_id=None,recipient_kind='self',method='position')['hits']
assert call('GET','/devices',token=acting['access_token'])[0]==200 and call('GET',f'/devices/{d1}/locations/latest',token=acting['access_token'])[0]==200
settle()
shared=one(share_id=link,method='position');path=one(share_id=link,method='track')
assert shared['recipient_kind']=='share_link' and shared['recipient_user_id'] is None and shared['subject_user_id']==uid and shared['device_id']==d1 and shared['path']==path['path']=='share_link'
assert found("g.recipient_kind='share_link' AND g.share_id IS NULL")==[]
stats=one(subject_user_id=uid,recipient_kind='company',method='stats')
assert stats['recipient_user_id']==mid and stats['device_id'] is None and stats['path']=='api'                    # the member, not the owner it acted for
if company[trips]==200:
 assert one(subject_user_id=uid,recipient_kind='company',method='trips')['vehicle_id']==vehicle
assert one(subject_user_id=uid,device_id=None,recipient_kind='self',method='stats')['recipient_user_id']==uid        # the owner in its own company scope is itself
everyone=one(all_subjects=True,recipient_kind='admin',recipient_user_id=aid,method='position')
assert everyone['subject_user_id'] is None and everyone['device_id'] is None
assert one(subject_user_id=uid,device_id=d1,recipient_kind='admin',path='api',method='position')['recipient_user_id']==aid
assert one(subject_user_id=uid,device_id=None,recipient_kind='admin',path='api',method='position')['recipient_user_id']==aid
for device_id in (None,d1):
 row=one(subject_user_id=uid,device_id=device_id,recipient_kind='admin',path='impersonation',method='position');assert row['recipient_user_id']==aid and row['hits']==1
assert one(subject_user_id=uid,device_id=None,recipient_kind='self',method='position')['hits']==before               # not recorded as the account's own read
check('a share link is recorded by its id with nobody named; a company member, an administrator and an administrator signed in as the account are each recorded as themselves, never as the account')

# ---- a live stream -------------------------------------------------------------------------------------------
def stream(access,devices):
 with socket.create_connection((apiip,3043),timeout=10) as s:
  s.sendall((f"GET /gps-tracker/ws/realtime?token={access} HTTP/1.1\r\nHost: {apiip}:3043\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {base64.b64encode(os.urandom(16)).decode()}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
  head=b''
  while b'\r\n\r\n' not in head:head+=s.recv(4096)
  assert b' 101 ' in head.split(b'\r\n')[0],head[:80]
  payload=json.dumps({'action':'subscribe','device_ids':devices}).encode();mask=os.urandom(4)
  s.sendall(bytes([0x81,0x80|len(payload)])+mask+bytes(b^mask[i%4] for i,b in enumerate(payload)));time.sleep(1.5)
stream(token,[d1,d2])                                   # the other account's device is refused by the stream
settle()
live=one(subject_user_id=uid,device_id=d1,recipient_kind='self',path='realtime',method='position')
assert live['hits']>=1 and found("g.path='realtime' AND g.device_id=%s",(d2,))==[]
check('opening a live stream is recorded for the devices it was allowed to follow, and not for a device it was refused')

# ---- nothing that locates a person, and nothing that can be changed ----------------------------------------
with db.cursor() as c:
 c.execute("SELECT string_agg(to_jsonb(g)::text,' ') FROM location_access_log g");everything=c.fetchone()[0]
 c.execute("SELECT array_agg(column_name::text) FROM information_schema.columns WHERE table_name='location_access_log'");columns=c.fetchone()[0]
for private in (LAT,LNG,NAME,TOKEN,owner['email']):assert private not in everything,private
assert not {'lat','lng','address','token','ip','note','data','raw'}&set(columns),columns
def refused(q,args=()):
 try:sql(q,args)
 except psycopg2.Error as e:return e.pgcode=='23514'
 return False
rowid=track['id']
for change in ("recipient_kind='self',recipient_user_id=%s"%oid,"subject_user_id=%s"%oid,'device_id=%s'%d2,"method='stats'","path='share_link'",'hits=hits-1',"last_at=last_at-interval '1 minute'","first_at=first_at-interval '1 second'","bucket_key='x'",'range_from=NULL',"range_until=range_until-interval '1 hour'"):
 assert refused(f'UPDATE location_access_log SET {change} WHERE id=%s',(rowid,)),change
assert refused('DELETE FROM location_access_log WHERE id=%s',(rowid,)) and refused('TRUNCATE location_access_log') and refused('TRUNCATE location_access_coverage')
assert refused("UPDATE location_access_coverage SET started_at=started_at-interval '1 day' WHERE id=%s",(first[-1]['id'],)) and refused('DELETE FROM location_access_coverage WHERE id=%s',(first[-1]['id'],))
assert refused("INSERT INTO location_access_log(bucket,first_at,last_at,hits,recipient_kind,path,method,bucket_key) VALUES(date_trunc('hour',now()),now(),now(),1,'self','api','position',%s)",(tag+'-nobody',))   # a self read names the account
assert one(id=rowid)==track
check('no coordinate, device name, link token or e-mail address is in the table, and a row cannot be re-attributed, reduced, emptied or deleted')

# ---- the administrator reads the ledger; the subject receives the record ------------------------------------
span=f"from={z(now()-timedelta(hours=1))}&until={z(now()+timedelta(minutes=1))}"
s,r,_=call('GET',f'/admin/location-access?user_id={uid}&{span}',token=at);assert s==200 and r['recording_now'] is True and r['minimum_keep_days']==185,(s,r)
assert r['recorded_periods'] and r['recorded_periods'][-1]['stopped_at'] is None and not r['more']
assert {x['recipient_kind'] for x in r['records']}=={'self','company','admin','share_link'} and all(x['subject_user_id']==uid or x['all_subjects'] for x in r['records'])
assert call('GET',f'/admin/location-access?user_id={uid}&{span}',token=token)[0]==403 and call('GET',f"/admin/location-access?from={z(now()-timedelta(days=40))}&until={z(now())}",token=at)[0]==400
assert sql("SELECT count(*) FROM admin_audit_log WHERE admin_id=%s AND target_user=%s AND action='location_access_read'",(aid,uid))==1
assert call('GET',f'/devices/{dc}',token=token)[0]==200;settle()                                  # a company-bound device of the same account
f,body=facts(rid,owner,window())
records=f['access_records']['records']
assert datetime.fromisoformat(f['access_records']['recording_started_at'].replace('Z','+00:00'))==datetime.fromisoformat(sql('SELECT min(started_at) FROM location_access_coverage').isoformat())
assert [p['ended'] for p in f['access_records']['recorded_periods']][-1]=='running'
assert {x['recipient'] for x in records}=={'self','company','admin','share_link'} and {'api','share_link','realtime','impersonation'}<={x['via'] for x in records}
assert any(x['all_accounts'] for x in records) and not any(x['device_id'] in (d2,dc) for x in records)   # never another account's device; company-bound devices go to their own review
assert set(records[0])=={'first_at','last_at','count','recipient','service','via','kind','device_id','vehicle_id','share_link_id','all_accounts','requested_from','requested_until'}
for private in (b'recipient_user_id',b'"lat"',b'"lng"',TOKEN.encode(),str(member['email']).encode(),str(admin['email']).encode()):assert private not in body,private
assert len(f['not_recorded'])==7 and '이전' in f['not_recorded'][0] and '소급해 만들지 않습니다' in f['not_recorded'][0] and not any('조회할 때마다의 기록을 남기지 않습니다' in s for s in f['not_recorded'])
orid=flow(other,'Another account');g,_=facts(orid,other,window())
assert all(x['all_accounts'] for x in g['access_records']['records'])                                   # only the reads of everyone's devices concern it
check('an administrator reads the ledger (and that reading is logged); the subject\'s file lists who received what and how without naming a member or an administrator, states the start of recording, and never claims a record from before it')

# ---- the periods of recording: a clean stop, a kill, a start -------------------------------------------------
assert call('GET',f'/devices/{d1}/events',token=token)[0] in (200,400);call('GET',f'/devices/{d1}',token=token)
api('stop');stopped=runs()
assert stopped[-1]['stopped_at'] is not None and one(subject_user_id=uid,device_id=d1,recipient_kind='self',path='api',method='position')['hits']>=3   # what was gathered is written on a clean stop
api('api',LEDGER='on');assert call('GET',f'/devices/{d1}',token=token)[0]==200;settle()
api('kill');killed=runs();assert len(killed)==len(stopped)+1 and killed[-1]['stopped_at'] is None
api('api',LEDGER='on');assert call('GET',f'/devices/{d1}',token=token)[0]==200;settle()
f,_=facts(rid,owner,window())
ended=[p['ended'] for p in f['access_records']['recorded_periods']]
assert ended[-3:]==['stopped','interrupted','running'],ended
periods=f['access_records']['recorded_periods']
assert all(datetime.fromisoformat(a['until'].replace('Z','+00:00'))<=datetime.fromisoformat(b['from'].replace('Z','+00:00')) for a,b in zip(periods,periods[1:]))
check('each run of the recorder is a period: a clean stop writes what was gathered and closes the period, a kill leaves it marked as interrupted, and the time between periods is not covered')

# ---- retention: nothing is removed unless it is configured, and never below the minimum ---------------------
def aged(days):return sql("INSERT INTO location_access_log(bucket,first_at,last_at,hits,subject_user_id,device_id,recipient_kind,recipient_user_id,path,method,bucket_key) SELECT t,t,t,1,%s,%s,'self',%s,'api','position',%s FROM (SELECT date_trunc('hour',now()-%s*interval '1 day') AS t) x RETURNING id",(uid,d1,uid,f'{tag}-aged-{days}',days))
a100,a200,a300=aged(100),aged(200),aged(300)
assert refused('DELETE FROM location_access_log WHERE id=%s',(a100,))               # younger than six months: the table itself refuses
sql('DELETE FROM location_access_log WHERE id=%s',(a300,));assert found('g.id=%s',(a300,))==[]
def wait(condition,seconds):
 for _ in range(seconds):
  if condition():return True
  time.sleep(1)
 return False
api('api',LEDGER='on',KEEP_DAYS='30')                                               # below the minimum: refused as a whole
assert not wait(lambda:found('g.id=%s',(a200,))==[],75) and found('g.id=%s',(a100,))!=[]
assert 'below the minimum' in subprocess.run(['docker','logs',API],capture_output=True,text=True).stderr+subprocess.run(['docker','logs',API],capture_output=True,text=True).stdout
api('api',LEDGER='on',KEEP_DAYS='190')
assert wait(lambda:found('g.id=%s',(a200,))==[],90) and found('g.id=%s',(a100,))!=[] and one(id=rowid)==track
api('api',LEDGER='on')
check('without a configured retention nothing is removed; a retention below six months removes nothing and says so; a configured retention removes only rows older than it')

# ---- what recording costs --------------------------------------------------------------------------------
def timed(n=300):
 took=[]
 for _ in range(n):
  start=time.perf_counter();assert call('GET',f'/devices/{d1}/locations/latest',token=token)[0]==200;took.append((time.perf_counter()-start)*1000)
 return round(statistics.median(took),2),round(sorted(took)[int(n*0.95)],2)
on=timed();settle()
row=lambda:sum(x['hits'] for x in found("g.subject_user_id=%s AND g.device_id=%s AND g.recipient_kind='self' AND g.path='api' AND g.method='position' AND g.bucket_key NOT LIKE %s",(uid,d1,'%aged%')))
count=row();rows_before=sql('SELECT count(*) FROM location_access_log')
with ThreadPoolExecutor(32) as pool:burst=list(pool.map(lambda _:call('GET',f'/devices/{d1}/locations/latest',token=token)[0],range(2000)))
assert set(burst)=={200};settle();time.sleep(2)
assert row()==count+2000 and sql('SELECT count(*) FROM location_access_log')-rows_before<=1 and runs()[-1]['dropped']==0      # every read counted, in at most one new row
periods_before=len(runs());api('api',LEDGER='');off=timed()        # this suite runs with LEDGER=on in its environment: say off explicitly
assert len(runs())==periods_before                      # a start without recording opens no period
api('api',LEDGER='on')
assert on[0]<=off[0]*1.5+3,(on,off)
check(f'2,000 concurrent reads are all counted in one row with none dropped; a read takes {on[0]} ms (95th percentile {on[1]}) with recording and {off[0]} ms ({off[1]}) without')

report={'mode':'on','integration_groups':len(passed),'groups':passed,'api_sha256':digest,'schema':sql('SELECT max(version) FROM _sqlx_migrations'),
        'read_ms_median_p95':{'recording':on,'not_recording':off},'burst':{'reads':2000,'threads':32,'new_rows':sql('SELECT count(*) FROM location_access_log')-rows_before,'dropped':0},
        'answered':{'own':tried,'company':company},'rows':sql('SELECT count(*) FROM location_access_log'),'periods':len(runs())}
assert report['schema']>=100,report['schema']
(here/'location-access-validation.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
