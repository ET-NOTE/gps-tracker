"""Corporate site CRUD, tenant scope and sampled SIM-ledger visits regression. Private clone only."""
import base64,datetime,hashlib,hmac,io,json,pathlib,sys,time,urllib.error,urllib.parse,urllib.request,uuid,zipfile
from concurrent.futures import ThreadPoolExecutor
import psycopg as psycopg2
envpath,base=sys.argv[1:3]
assert base=='http://172.28.0.3:3043'
env={k:v.strip().strip('"').strip("'") for k,v in (l.split('=',1) for l in pathlib.Path(envpath).read_text().splitlines() if '=' in l and not l.startswith('#'))}
assert urllib.parse.urlsplit(env['DATABASE_URL']).path=='/gps_closure_test'
db=psycopg2.connect(env['DATABASE_URL']);db.autocommit=True;db.execute("SELECT set_config('gps.storage_keys',%s,false)",(pathlib.Path(__file__).with_name('test-keys.json').read_text(),));cur=db.cursor();users=[];devices=[];run=uuid.uuid4().hex;checks=[]
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

def site(owner,name,geometry,group=None):return call(owner,'POST','/corporate/sites',dict(name=name,address='검증용 주소',group_id=group,geometry=geometry,active=True,note='isolated fixture'))
def update(owner,s,**kw):return call(owner,'PUT',f"/corporate/sites/{s['id']}",dict(s,**kw))
def wait_for(predicate):
 deadline=time.monotonic()+70
 while time.monotonic()<deadline:
  if predicate():return
  time.sleep(1)
 raise AssertionError('Visit worker did not converge')
def point(d,u,minute,lat=37,lng=127,fix=True):
 sql("INSERT INTO location_records(device_id,user_id,source,fix,lat,lng,recorded_at) VALUES(%s,%s,'l80',%s,%s,%s,%s)",(d,u,fix,lat,lng,t0+datetime.timedelta(minutes=minute)))
def visits(u,**kw):return call(u,'GET','/corporate/site-visits?from='+day+'&to='+day,**kw)['items']
locked=False
try:
 for label in ['owner','admin','member','outsider']:
  users.append(sql("INSERT INTO users(email,password_hash,display_name,phone) VALUES(%s,'test-only','Site regression','01000000000') RETURNING id",(f'sites-{run}-{label}@example.invalid',)))
 a,admin,member,outsider=users
 va=vehicle(a,'본사 업무차',None);vb=vehicle(a,'별도 업무차',None)
 sa=staff(a,'관리자',access_role='admin');sm=staff(a,'직원',all_vehicles=False,vehicle_ids=[va['id']])
 accept(a,sa,admin);accept(a,sm,member)
 g=call(a,'POST','/corporate/site-groups',dict(name='본사',active=True));fg=call(outsider,'POST','/corporate/site-groups',dict(name='외부',active=True))
 circle=dict(type='circle',lat=37,lng=127,radius_m=100)
 polygon=dict(type='polygon',points=[[36.999,126.999],[37.001,126.999],[37.001,127.001],[36.999,127.001]])
 c=site(a,'본사',circle,g['id']);p=site(a,'구역',polygon,g['id']);foreign=site(outsider,'외부 지점',circle,fg['id'])
 check('circle and polygon creation',len(call(a,'GET','/corporate/sites'))==2)
 call(a,'POST','/corporate/sites',dict(c,group_id=fg['id']),400)
 call(a,'PUT',f"/corporate/sites/{foreign['id']}",foreign,404)
 call(outsider,'GET','/corporate/sites',owner=a,expected=403)
 call(member,'POST','/corporate/sites',c,owner=a,expected=403)
 call(member,'PUT',f"/corporate/site-groups/{g['id']}",g,owner=a,expected=403)
 check('company and role boundaries',len(call(member,'GET','/corporate/sites',owner=a))==2 and len(call(member,'GET','/corporate/site-groups',owner=a))==1)
 c=call(admin,'PUT',f"/corporate/sites/{c['id']}",dict(c,note='관리자 수정'),owner=a)
 check('actual actor audited',sql("SELECT actor_id FROM gps_read_fleet_team_audit WHERE owner_id=%s AND action='site' ORDER BY id DESC LIMIT 1",(a,))==admin)
 call(a,'PUT',f"/corporate/sites/{c['id']}",dict(c,updated_at='2020-01-01T00:00:00Z'),409)
 for geometry in [dict(circle,radius_m=0),dict(circle,lat=91),dict(type='polygon',points=[[37,127],[37.01,127.01],[37,127.01],[37.01,127]]),dict(type='polygon',points=[[37,127],[37.01,127]])]:
  call(a,'POST','/corporate/sites',dict(c,geometry=geometry),400)
 check('invalid coordinates, zero radius, crossing and short polygons rejected')
 call(a,'POST','/corporate/site-groups',dict(name='본사',active=True),409)
 disabled=call(a,'PUT',f"/corporate/site-groups/{g['id']}",dict(g,active=False))
 call(a,'POST','/corporate/sites',c,400)
 c=update(a,c,note='기존 중지 그룹 유지')
 check('inactive group retained only by existing site',c['group_id']==g['id'])
 call(a,'PUT',f"/corporate/site-groups/{g['id']}",dict(disabled,active=True))
 # Hold the production worker's lock only on the isolated DB while fixtures are prepared.
 sql('SELECT pg_advisory_lock(7541,1)');locked=True
 t0=datetime.datetime.now(datetime.timezone.utc).replace(hour=0,minute=0,second=0,microsecond=0)
 # Ensure all samples below are in the past even when a validation runs early UTC.
 t0-=datetime.timedelta(days=1);day=(t0+datetime.timedelta(hours=9)).date().isoformat()
 for s in [c,p,foreign]:
  sql('UPDATE fleet_sites SET detection_from=%s WHERE id=%s',(t0,s['id']))
  sql('DELETE FROM fleet_site_versions WHERE site_id=%s',(s['id'],))
  sql('INSERT INTO fleet_site_versions(site_id,owner_id,valid_from,snapshot) SELECT id,owner_id,%s,to_jsonb(s) FROM gps_read_fleet_sites s WHERE id=%s',(t0,s['id']))
 for n in range(3):devices.append(sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'') RETURNING id",(f'sites-{run}-{n}',a)))
 binds=[]
 for v,d,primary in [(va,devices[0],True),(vb,devices[1],True),(va,devices[2],False)]:
  binds.append(sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,is_primary,started_at) VALUES(%s,%s,%s,'SIM fixture',%s,%s) RETURNING id",(v['id'],a,d,primary,t0)))
 for minute,lat in [(0,37.01),(1,37),(2,37),(3,37.01),(4,37),(45,37),(46,37),(47,37.01)]:point(devices[0],a,minute,lat)
 point(devices[0],a,2.5,37.01,fix=False)
 point(devices[0],outsider,2.7,37.01) # exact receiving-owner isolation
 point(devices[2],a,1,37) # secondary SIM must not double-count
 fixes=[dict(at_ms=-60000,lat=37,lng=127),dict(at_ms=0,lat=37,lng=127),dict(at_ms=60000,lat=37.01,lng=127)]
 sql("INSERT INTO location_records(device_id,user_id,source,fix,recorded_at,fixes_jsonb) VALUES(%s,%s,'l80',true,%s,%s::jsonb)",(devices[1],a,t0+datetime.timedelta(minutes=2),json.dumps(fixes)))
 sql('SELECT pg_advisory_unlock(7541,1)');locked=False
 wait_for(lambda:sql('SELECT count(*) FROM gps_read_fleet_site_visits WHERE owner_id=%s',(a,))==8)
 rows=visits(a);member_rows=visits(member,owner=a)
 check('overlapping circle and polygon each get sampled visits',len(rows)==8)
 check('staff visit history restricted to assigned vehicle',len(member_rows)==6 and all(v['vehicle_id']==va['id'] for v in member_rows))
 check('other company cannot see visits',not visits(outsider))
 cr=[v for v in rows if v['site_id']==c['id'] and v['vehicle_id']==va['id']]
 check('exit, gap and observed entry semantics',{v['end_reason'] for v in cr}=={'exit','gap'} and sum(v['start_kind']=='observed' for v in cr)==1)
 check('dwell does not bridge 41-minute reporting gap',sorted(v['observed_seconds'] for v in cr)==[0,60,60])
 batch=[v for v in rows if v['vehicle_id']==vb['id']]
 check('batch point timestamps, not upload anchors',len(batch)==2 and all(v['observed_seconds']==60 and datetime.datetime.fromisoformat(v['first_inside_at'])==t0+datetime.timedelta(minutes=1) for v in batch))
 call(member,'GET',f"/corporate/site-visits?from={day}&to={day}&vehicle_id={vb['id']}",owner=a,expected=404)
 call(a,'GET',f"/corporate/site-visits?site_id={foreign['id']}",expected=404)
 call(a,'GET','/corporate/site-visits?from=2020-01-01&to=2026-10-29',expected=400)
 check('visit ID, vehicle and range guards')
 # New forward points drive another cycle; old replay must not change earlier visits.
 point(devices[0],a,2.2,37.01);point(devices[0],a,48,37)
 wait_for(lambda:sql('SELECT count(*) FROM gps_read_fleet_site_visits WHERE owner_id=%s',(a,))==10)
 check('late older points do not rewrite completed visits',len(visits(a))==10 and sorted(v['observed_seconds'] for v in visits(a) if v['id'] in [r['id'] for r in cr])==[0,60,60])
 # Trip endpoint names are effective-time version snapshots, not current names.
 for kind,minute in [('wake',1),('sleep_enter',2)]:sql('INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,%s,%s)',(devices[0],a,kind,t0+datetime.timedelta(minutes=minute)))
 c=next(s for s in call(a,'GET','/corporate/sites') if s['id']==c['id'])
 c=update(a,c,name='이름 변경 후')
 trips=call(a,'GET',f"/corporate/vehicles/{va['id']}/trips?from={day}&to={day}&include_no_coord=true")
 check('trip endpoint retains historical site name',any(any(s['name']=='본사' for s in t['start_sites']) for t in trips))
 check('visit rename preserves original snapshot',all(v['site_name']=='본사' for v in visits(a) if v['site_id']==c['id']))
 c=update(a,c,geometry=dict(circle,radius_m=150))
 check('geometry edit closes presence without false exit',sql("SELECT count(*) FROM gps_read_fleet_site_visits WHERE site_id=%s AND end_reason='configuration' AND outside_at IS NULL",(c['id'],))==1)
 sql('UPDATE fleet_vehicle_bindings SET ended_at=%s WHERE id=%s',(t0+datetime.timedelta(minutes=49),binds[0]))
 point(devices[0],a,49,37) # half-open binding boundary is excluded
 wait_for(lambda:sql("SELECT count(*) FROM gps_read_fleet_site_visits WHERE binding_id=%s AND end_reason='binding_end'",(binds[0],))==1)
 check('binding close retains prior vehicle history',sql('SELECT max(last_inside_at) FROM gps_read_fleet_site_visits WHERE binding_id=%s',(binds[0],))==t0+datetime.timedelta(minutes=48))
 check('SIM source ownership and raw points unchanged',sql('SELECT count(*) FROM gps_read_location_records WHERE device_id=%s AND user_id=%s',(devices[0],outsider))==1)
 check('personal fences unchanged',sql('SELECT count(*) FROM gps_read_geofences WHERE owner_id=ANY(%s)',(users,))==0)
 check('no notification generated by company site processing',sql('SELECT count(*) FROM gps_read_events WHERE user_id=ANY(%s) AND kind LIKE %s',(users,'geofence%'))==0)
 p=next(s for s in call(a,'GET','/corporate/sites') if s['id']==p['id'])
 update(a,p,active=False)
 check('disabled site keeps historical visits',len(visits(a))==10)
 # Insert in reverse chronology to ensure pagination follows sampled time, not ID.
 for n in range(103):
  at=t0+datetime.timedelta(minutes=200-n)
  sql("INSERT INTO fleet_site_visits(owner_id,site_id,vehicle_id,binding_id,site_name,vehicle_name,first_inside_at,last_inside_at,start_kind,end_reason,closed_at) VALUES(%s,%s,%s,%s,'페이지 검증','차량',%s,%s,'observed','exit',now())",(a,p['id'],va['id'],binds[0],at,at))
 first=call(a,'GET',f'/corporate/site-visits?from={day}&to={day}')
 second=call(a,'GET',f"/corporate/site-visits?from={day}&to={day}&before={first['next_before']}")
 combined=first['items']+second['items']
 check('visit pagination follows observed time without loss or duplicates',len(combined)==113 and len({v['id'] for v in combined})==113 and [v['first_inside_at'] for v in combined]==sorted([v['first_inside_at'] for v in combined],reverse=True))
 check('foreign pagination cursor cannot expose another company',not call(outsider,'GET',f"/corporate/site-visits?from={day}&to={day}&before={first['next_before']}")['items'])
 print(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False))
finally:
 if locked:sql('SELECT pg_advisory_unlock(7541,1)')
 if users:
  cur.execute('DELETE FROM fleet_sites WHERE owner_id=ANY(%s)',(users,))
  for table in ['vehicle_reservations','trip_annotations']:cur.execute('DELETE FROM '+table+' WHERE user_id=ANY(%s)',(users,))
  cur.execute('DELETE FROM fleet_vehicles WHERE owner_id=ANY(%s)',(users,));cur.execute('DELETE FROM staff WHERE user_id=ANY(%s)',(users,))
  cur.execute('DELETE FROM devices WHERE id=ANY(%s)',(devices,));cur.execute('SELECT count(*) FROM users WHERE id=ANY(%s)',(users,))
 db.close()
