"""Review/apply trip assignments, role isolation and SIM continuity. Private clone only."""
import base64,datetime,hashlib,hmac,io,json,pathlib,sys,time,urllib.error,urllib.parse,urllib.request,uuid,zipfile
from concurrent.futures import ThreadPoolExecutor
import psycopg2
envpath,base=sys.argv[1:3]
assert base=='http://127.0.0.1:3042'
env={k:v.strip().strip('"').strip("'") for k,v in (l.split('=',1) for l in pathlib.Path(envpath).read_text().splitlines() if '=' in l and not l.startswith('#'))}
assert urllib.parse.urlsplit(env['DATABASE_URL']).path=='/gps_tracker_dev_prodreview_20261020'
db=psycopg2.connect(env['DATABASE_URL']);db.autocommit=True;cur=db.cursor();users=[];devices=[];run=uuid.uuid4().hex;checks=[]
def sql(q,args=()):
 cur.execute(q,args);return cur.fetchone()[0] if cur.description else None
def jwt(user):
 enc=lambda v:base64.urlsafe_b64encode(json.dumps(v).encode()).rstrip(b'=')
 raw=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'sub':str(user),'typ':'access','iat':int(time.time()),'exp':int(time.time())+1800})
 return (raw+b'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),raw,hashlib.sha256).digest()).rstrip(b'=')).decode()
def call(user,method,path,body=None,expected=200,owner=None,binary=False):
 headers={'Content-Type':'application/json'}
 if user:headers['Authorization']='Bearer '+jwt(user)
 if owner:headers['X-Fleet-Owner']=str(owner)
 req=urllib.request.Request(base+'/gps-tracker/api/v1'+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
 try:
  with urllib.request.urlopen(req,timeout=45) as res:status=res.status;data=res.read()
 except urllib.error.HTTPError as e:status=e.code;data=e.read()
 if expected is None:return status
 assert status==expected,(method,path,status,data[:180])
 return data if binary else json.loads(data)
def check(name,condition=True):assert condition,name;checks.append(name)

def upload(user,path,fields,image):
 boundary='team-fixture-'+run
 data=b''
 for name,value in fields.items():data+=(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n').encode()
 data+=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n').encode()+image+f'\r\n--{boundary}--\r\n'.encode()
 req=urllib.request.Request(base+'/gps-tracker/api/v1'+path,data=data,headers={'Authorization':'Bearer '+jwt(user),'Content-Type':'multipart/form-data; boundary='+boundary})
 with urllib.request.urlopen(req) as res:return json.loads(res.read())
def staff(owner,name,**kw):return call(owner,'POST','/corporate/staff',dict(name=name,**kw))
def item(owner,kind,name):return call(owner,'POST','/corporate/organization/items',dict(kind=kind,name=name,active=True))
def vehicle(owner,name,dep):return call(owner,'POST','/corporate/vehicles',dict(name=name,department_id=dep,enabled=True,profile={}))
def invite(owner,s):return call(owner,'POST','/corporate/invites',dict(staff_id=s['id']))
def accept(owner,s,user):
 i=invite(owner,s);r=call(user,'POST','/corporate/join',dict(code=i['code'],confirm=False))
 assert r['owner_id']==owner and r['staff_id']==s['id']
 assert not sql('SELECT EXISTS(SELECT 1 FROM fleet_staff_accounts WHERE owner_id=%s AND account_id=%s)',(owner,user))
 call(user,'POST','/corporate/join',dict(code=i['code'],confirm=True));return i

try:
 for label in ['owner','admin','manager','member','outsider']:
  users.append(sql("INSERT INTO users(email,password_hash,display_name,phone) VALUES(%s,'test-only','Assignment regression','01000000000') RETURNING id",(f'assignment-{run}-{label}@example.invalid',)))
 a,admin,manager,member,outsider=users
 dep=item(a,'department','영업팀');otherdep=item(a,'department','다른 부서')
 va=vehicle(a,'영업차량',dep['id']);vb=vehicle(a,'다른 차량',otherdep['id'])
 sa=staff(a,'관리자',access_role='admin');sm=staff(a,'직원',department_id=dep['id'],all_vehicles=False,vehicle_ids=[va['id']]);sg=staff(a,'부서장',department_id=dep['id'],access_role='department_manager');so=staff(a,'다른 부서',department_id=otherdep['id'],all_vehicles=False,vehicle_ids=[vb['id']])
 for s,u in [(sa,admin),(sm,member),(sg,manager)]:accept(a,s,u)
 t0=datetime.datetime(2026,10,26,tzinfo=datetime.timezone.utc)
 day='2026-10-26'
 device=sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'') RETURNING id",('assignment-'+run,a));devices.append(device)
 bid=sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,is_primary,started_at) VALUES(%s,%s,%s,'assignment fixture',true,%s) RETURNING id",(va['id'],a,device,t0-datetime.timedelta(days=1)))
 for hour in [0,2,4]:
  for kind,minute in [('wake',1),('sleep_enter',20)]:sql('INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,%s,%s)',(device,a,kind,t0+datetime.timedelta(hours=hour,minutes=minute)))
  for minute,lat in [(1,37),(10,37.01),(20,37.02)]:sql("INSERT INTO location_records(device_id,user_id,source,fix,lat,lng,recorded_at) VALUES(%s,%s,'l80',true,%s,127,%s)",(device,a,lat,t0+datetime.timedelta(hours=hour,minutes=minute)))
 root=f"/corporate/vehicles/{va['id']}"
 def trips():return call(a,'GET',root+f'/trips?from={day}&to={day}')
 ts=sorted(trips(),key=lambda t:t['started_at']);assert len(ts)==3,len(ts)
 keys=[dict(source_device_id=device,binding_id=bid,trip_started_at=t['source_started_at']) for t in ts]
 def body(indices=[0],**kw):return {'from':day,'to':day,'trips':[keys[i] for i in indices],'mode':'suggest',**kw}
 def assign(p,user=None,expected=200):return call(user or a,'POST',root+'/trips/assign',p,owner=a if user and user!=a else None,expected=expected)
 def apply(p,user=None):
  preview=assign(p,user);return assign(dict(p,preview_token=preview['preview_token']),user)
 rule=dict(name='기본',kind='default',weekdays=[],start_min=0,end_min=1440,valid_from=day,driver_staff_id=sm['id'],purpose='business',active=True)
 call(member,'POST',root+'/trip-rules',rule,owner=a,expected=403)
 call(manager,'POST',root+'/trip-rules',rule,owner=a,expected=403)
 call(outsider,'GET',root+'/trip-rules',expected=404)
 r=call(admin,'POST',root+'/trip-rules',rule,owner=a)
 check('only administrators manage rules',r['owner_id']==a)
 foreign_staff=staff(outsider,'다른 회사 직원')
 call(a,'POST',root+'/trip-rules',dict(rule,active=False,driver_staff_id=foreign_staff['id']),expected=400)
 check('inactive rules cannot reference foreign staff')
 call(a,'POST',root+'/trip-rules',rule,expected=409)
 call(a,'POST',root+'/trip-rules',dict(rule,kind='weekly',weekdays=[]),expected=400)
 call(a,'PUT',root+f"/trip-rules/{r['id']}",dict(rule,updated_at='2020-01-01T00:00:00Z'),expected=409)
 check('default uniqueness, weekday and stale rule validation')
 p=body([0,1]);preview=assign(p)
 check('preview has no writes',preview['ready']==2 and sql('SELECT count(*) FROM trip_annotations WHERE user_id=%s',(a,))==0)
 result=assign(dict(p,preview_token=preview['preview_token']))
 check('default rule applied to selected trips only',result['applied']==2 and sql('SELECT count(*) FROM trip_annotations WHERE user_id=%s',(a,))==2)
 assign(dict(p,preview_token=preview['preview_token']),expected=409)
 check('replayed preview cannot overwrite changes')
 check('driver snapshot and source saved',trips()[0]['annotation']['driver_name']=='직원' and trips()[0]['annotation']['assignment_source']['source']['kind']=='default')
 # Direct annotation edit preserves fuel/note during bulk assignment.
 ann=dict(keys[0],purpose='business',driver_staff_id=sm['id'],fuel_cost=12345,fuel_liters=4,note='보존할 메모')
 call(a,'PATCH',root+'/trips/annotation',ann)
 manual=body([0],mode='manual',change_driver=True,driver_staff_id=sg['id'],change_purpose=True,purpose='commute')
 check('manual preserves existing values by default',assign(manual)['ready']==0)
 manual['overwrite']=True;apply(manual)
 current=sorted(trips(),key=lambda t:t['started_at'])[0]['annotation']
 check('bulk preserves unrelated fuel and note',current['fuel_cost']==12345 and current['fuel_liters']==4 and current['note']=='보존할 메모' and current['purpose']=='commute')
 # Member cannot change someone else's trip or assign another staff member.
 selfp=body([0],mode='manual',change_purpose=True,purpose='business',overwrite=True)
 check('member cannot overwrite another driver',assign(selfp,member)['ready']==0)
 sql('UPDATE staff SET name=%s WHERE id=%s',('변경된 이름',sg['id']))
 name_preview=assign(selfp)
 check('purpose-only preview preserves historic driver snapshot',name_preview['rows'][0]['after']['driver_name']==current['driver_name'])
 assign(manual,member,expected=403)
 foreign=body([2],mode='manual',change_driver=True,driver_staff_id=so['id']);check('disallowed driver skipped',assign(foreign)['ready']==0)
 check('actual acting administrator retained',sql("SELECT EXISTS(SELECT 1 FROM fleet_trip_assignment_audit WHERE owner_id=%s AND actor_id=%s AND action='rule')",(a,admin)))
 # Same annotation edited after preview: no partial application.
 p=body([0,1],mode='manual',change_purpose=True,purpose='other',purpose_note='검토',overwrite=True);pr=assign(p)
 call(a,'PATCH',root+'/trips/annotation',dict(ann,note='다른 수정'))
 assign(dict(p,preview_token=pr['preview_token']),expected=409)
 check('stale multi-row preview applies nothing',sql("SELECT count(*) FROM trip_annotations WHERE user_id=%s AND purpose='other'",(a,))==0)
 c=sorted(trips(),key=lambda t:t['started_at'])[0]['annotation']
 call(a,'PATCH',root+'/trips/annotation',dict(ann,expected_version=c['updated_at']))
 call(a,'PATCH',root+'/trips/annotation',dict(ann,expected_version=c['updated_at']),expected=409)
 call(a,'PATCH',root+'/trips/annotation',dict(keys[2],purpose='business',expected_version='invalid'),expected=400)
 check('single edit version guards')
 # Full reservation takes precedence over rules, separate structured purpose.
 booking=dict(vehicle_id=va['id'],driver_staff_id=sg['id'],starts_at=(t0+datetime.timedelta(hours=4)).isoformat(),ends_at=(t0+datetime.timedelta(hours=5)).isoformat(),purpose='거래처 방문',report_purpose='other',status='planned')
 b=call(a,'POST','/corporate/vehicle-reservations',booking)
 pp=body([2]);pr=assign(pp);check('reservation wins over default',pr['rows'][0]['source']['kind']=='reservation' and pr['rows'][0]['after']['driver_staff_id']==sg['id'] and pr['rows'][0]['after']['purpose_note']=='거래처 방문')
 b=call(a,'PUT',f"/corporate/vehicle-reservations/{b['id']}",dict(booking,purpose='예약 수정'))
 assign(dict(pp,preview_token=pr['preview_token']),expected=409)
 check('reservation changes invalidate preview')
 call(a,'PUT',f"/corporate/vehicle-reservations/{b['id']}",dict(booking,starts_at=(t0+datetime.timedelta(hours=4,minutes=10)).isoformat()))
 check('partial reservation blocks fallback',assign(pp)['ready']==0)
 call(a,'DELETE',f"/corporate/vehicle-reservations/{b['id']}")
 weekly=dict(rule,name='월요일',kind='weekly',weekdays=[1],start_min=780,end_min=840,driver_staff_id=sg['id'],purpose='commute')
 w=call(a,'POST',root+'/trip-rules',weekly)
 pr=assign(pp);check('weekly KST priority',pr['rows'][0]['source']['kind']=='weekly' and pr['rows'][0]['after']['purpose']=='commute')
 w2=call(a,'POST',root+'/trip-rules',dict(weekly,name='겹치는 규칙'))
 check('ambiguous weekly rules are skipped',assign(pp)['ready']==0)
 call(a,'PUT',root+f"/trip-rules/{w2['id']}",dict(w2,active=False))
 pr=assign(pp)
 statuses=list(ThreadPoolExecutor(2).map(lambda _:assign(dict(pp,preview_token=pr['preview_token']),expected=None),range(2)))
 check('simultaneous apply has one winner',sorted(statuses)==[200,409])
 # Moving a primary binding invalidates a reviewed allocation.
 p=body([2],mode='manual',change_purpose=True,purpose='business',overwrite=True);pr=assign(p)
 sql('UPDATE fleet_vehicle_bindings SET ended_at=%s WHERE id=%s',(t0+datetime.timedelta(hours=3),bid))
 assign(dict(p,preview_token=pr['preview_token']),expected=409)
 sql('UPDATE fleet_vehicle_bindings SET ended_at=NULL WHERE id=%s',(bid,))
 check('SIM handover invalidates reviewed trip keys')
 audit=call(a,'GET',root+'/trips/assignment-history');check('annotation history captures before/after',any(x['action']=='annotation' and x['before_value'] and x['after_value'] for x in audit))
 call(member,'GET',root+'/trips/assignment-history',owner=a,expected=403)
 call(outsider,'POST',root+'/trips/assign',p,expected=404)
 assign(body([0,0]),expected=400);assign(body([]),expected=400)
 check('history ownership and duplicate selection guards')
 check('SIM measurements unchanged',sql('SELECT count(*) FROM location_records WHERE user_id=%s AND device_id=%s',(a,device))==9 and sql('SELECT count(*) FROM events WHERE user_id=%s AND device_id=%s',(a,device))==6)
 print(json.dumps({'assignment_checks':len(checks),'checks':checks},ensure_ascii=False))
finally:
 if users:sql('DELETE FROM fleet_trip_rules WHERE owner_id=ANY(%s)',(users,))
 if devices:sql('DELETE FROM devices WHERE id=ANY(%s)',(devices,))
 if users:sql('DELETE FROM users WHERE id=ANY(%s)',(users,))
 db.close()

