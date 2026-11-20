"""Invitation, organization and delegated access regression. Private clone only."""
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
 for label in ['owner','admin','manager','member','outsider','another','pending']:
  users.append(sql("INSERT INTO users(email,password_hash,display_name,phone) VALUES(%s,'test-only','Team regression','01000000000') RETURNING id",(f'team-{run}-{label}@example.invalid',)))
 a,admin,manager,member,outsider,another,pending=users
 dep1=item(a,'department','영업부');dep2=item(a,'department','지원부');pos=item(a,'position','팀장');foreign=item(outsider,'department','다른 회사')
 va=vehicle(a,'영업 차량',dep1['id']);vb=vehicle(a,'지원 차량',dep2['id']);vc=vehicle(outsider,'외부 차량',foreign['id'])
 call(a,'POST','/corporate/vehicles',dict(name='invalid',department_id=foreign['id'],enabled=True),400)
 call(a,'POST','/corporate/staff',dict(name='invalid',department_id=pos['id']),400)
 check('foreign organization and wrong kind rejected')
 sa=staff(a,'관리 담당',access_role='admin');sm=staff(a,'영업 관리자',access_role='department_manager',department_id=dep1['id']);se=staff(a,'직원',department_id=dep1['id'],position_id=pos['id'],all_vehicles=False,vehicle_ids=[va['id']]);sp=staff(a,'대기 직원')
 call(a,'POST','/corporate/staff',dict(name='invalid',vehicle_ids=[vc['id']]),404)
 for s,u in [(sa,admin),(sm,manager),(se,member)]:accept(a,s,u)
 check('preview is read only and three roles accept invitations')
 check('personal scope is unchanged',not call(member,'GET','/corporate/vehicles'))
 check('workspace membership listed',call(member,'GET','/corporate/workspaces')['memberships'][0]['owner_id']==a)
 for u,allowed in [(admin,{va['id'],vb['id']}),(manager,{va['id']}),(member,{va['id']})]:
  rows=call(u,'GET','/corporate/vehicles',owner=a);check(f'vehicle collection scoped {u}',{r['id'] for r in rows}==allowed)
  rows=call(u,'GET','/corporate/vehicle-stats',owner=a)['per_device'];check(f'statistics scoped {u}',{r['vehicle_id'] for r in rows}==allowed)
 call(outsider,'GET','/corporate/vehicles',owner=a,expected=403)
 for u in [manager,member]:
  call(u,'GET',f"/corporate/vehicles/{vb['id']}",owner=a,expected=404)
  call(u,'POST','/corporate/vehicles',dict(name='no',enabled=True),owner=a,expected=403)
  call(u,'POST','/corporate/staff',dict(name='no'),owner=a,expected=403)
  call(u,'GET',f"/corporate/vehicles/{va['id']}/bindings",owner=a,expected=403)
  call(u,'GET','/corporate/team-audit',owner=a,expected=403)
 check('direct ID and management endpoints reject limited roles')
 for u in [admin,manager,member]:
  for path in ['/devices','/auth/me','/corporate/workspaces','/corporate/devices/1/trips','/corporate/fleet/trip-stats','/corporate/reservations']:
   call(u,'GET',path,owner=a,expected=403)
  call(u,'POST','/corporate/subscription',{},owner=a,expected=403)
  call(u,'GET','/corporate/subscription',owner=a)
 check('SIM personal legacy and billing scopes are not delegated')
 call(admin,'PATCH',f"/corporate/staff/{sa['id']}",dict(name='forbidden'),owner=a,expected=403)
 call(admin,'PATCH',f"/corporate/staff/{se['id']}",dict(access_role='admin'),owner=a,expected=403)
 call(admin,'POST','/corporate/invites',dict(staff_id=sa['id']),owner=a,expected=403)
 check('delegated administrator cannot grant or modify administrator privileges')
 rows=call(member,'GET','/corporate/staff',owner=a);check('member sees only own staff record',[s['id'] for s in rows]==[se['id']])
 rows=call(manager,'GET','/corporate/staff',owner=a);check('department manager sees own department',{s['id'] for s in rows}=={se['id'],sm['id']})
 # Pending invites are hashed, replace/revoke/expiry/one-use/concurrent acceptance.
 i=invite(a,sp);check('token is not stored or listed',sql('SELECT token_hash FROM fleet_invites WHERE id=%s',(i['id'],))==hashlib.sha256(i['code'].encode()).hexdigest() and i['code'] not in json.dumps(call(a,'GET','/corporate/invites')))
 call(None,'POST','/corporate/join',dict(code=i['code']),401)
 j=invite(a,sp);call(pending,'POST','/corporate/join',dict(code=i['code'],confirm=True),404)
 call(a,'DELETE',f"/corporate/invites/{j['id']}");call(pending,'POST','/corporate/join',dict(code=j['code'],confirm=True),404)
 j=invite(a,sp);sql("UPDATE fleet_invites SET expires_at=now()-interval '1 minute' WHERE id=%s",(j['id'],));call(pending,'POST','/corporate/join',dict(code=j['code']),404)
 j=invite(a,sp)
 with ThreadPoolExecutor(max_workers=2) as ex:statuses=list(ex.map(lambda u:call(u,'POST','/corporate/join',dict(code=j['code'],confirm=True),expected=None),[pending,another]))
 check('invitation consumed once under concurrency',sorted(statuses)==[200,404])
 call(outsider,'POST','/corporate/join',dict(code=j['code'],confirm=True),404)
 check('replaced revoked expired and consumed invitations rejected')
 # A second record cannot silently replace an account already linked in this company.
 spare=staff(a,'중복 연결 시험');i=invite(a,spare)
 call(member,'POST','/corporate/join',dict(code=i['code'],confirm=True),409)
 call(outsider,'POST','/corporate/join',dict(code=i['code'],confirm=True))
 check('failed duplicate acceptance does not consume invitation')
 # Organization changes preserve historical records and disallow new inactive choices.
 current=call(a,'GET','/corporate/staff');current=next(s for s in current if s['id']==spare['id'])
 call(a,'PATCH',f"/corporate/staff/{spare['id']}",dict(phone='01000000001',updated_at=current['updated_at']))
 call(a,'PATCH',f"/corporate/staff/{spare['id']}",dict(phone='01000000002',updated_at=current['updated_at']),409)
 inactive=call(a,'PUT',f"/corporate/organization/items/{pos['id']}",dict(kind='position',name='팀장',active=False,updated_at=pos['updated_at']))
 call(a,'POST','/corporate/staff',dict(name='invalid',position_id=pos['id']),400)
 call(a,'PATCH',f"/corporate/staff/{se['id']}",dict(phone='01000000003'))
 call(a,'PUT',f"/corporate/organization/items/{pos['id']}",dict(kind='position',name='팀장',active=True,updated_at=pos['updated_at']),409)
 check('stale writes rejected and inactive organization preserves existing assignment')
 image=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=')
 upload(a,f"/corporate/vehicles/{va['id']}/photo",{},image)
 doc=upload(a,f"/corporate/vehicles/{va['id']}/documents",{'kind':'registration'},image)
 check('member may read assigned vehicle photo',call(member,'GET',f"/corporate/vehicles/{va['id']}/photo",owner=a,binary=True)==image)
 call(member,'GET',f"/documents/{doc['id']}/download",owner=a,expected=403)
 call(member,'GET',f"/corporate/vehicles/{va['id']}/documents",owner=a,expected=403)
 check('department manager reads own vehicle document',call(manager,'GET',f"/documents/{doc['id']}/download",owner=a,binary=True)==image)
 call(a,'DELETE',f"/documents/{doc['id']}")
 # Selected car permission controls booking driver, even for the owner.
 booking=dict(vehicle_id=va['id'],driver_staff_id=se['id'],starts_at='2027-03-01T01:00:00Z',ends_at='2027-03-01T02:00:00Z')
 br=call(member,'POST','/corporate/vehicle-reservations',booking,owner=a)
 call(member,'POST','/corporate/vehicle-reservations',dict(booking,driver_staff_id=sm['id']),owner=a,expected=403)
 call(member,'PUT',f"/corporate/vehicle-reservations/{br['id']}",dict(booking,vehicle_id=vb['id']),owner=a,expected=404)
 call(a,'POST','/corporate/vehicle-reservations',dict(booking,vehicle_id=vb['id']),400)
 rb=call(a,'POST','/corporate/vehicle-reservations',dict(booking,vehicle_id=vb['id'],driver_staff_id=sa['id']))
 call(member,'DELETE',f"/corporate/vehicle-reservations/{rb['id']}",owner=a,expected=404)
 rows=call(member,'GET','/corporate/vehicle-reservations?from=2027-03-01T00:00:00Z&to=2027-03-02T00:00:00Z',owner=a)
 check('bookings restrict both source target and driver',[r['id'] for r in rows]==[br['id']])
 # Original SIM telemetry identity is untouched by invitations and scopes.
 for n in range(2):devices.append(sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'') RETURNING id",(f'team-{run}-{n}',a)))
 for v,d in [(va,devices[0]),(vb,devices[1])]:
  sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,is_primary,started_at) VALUES(%s,%s,%s,'SIM fixture',true,'2026-10-01')",(v['id'],a,d))
 terminals=call(member,'GET','/corporate/terminals',owner=a)
 check('terminal list follows authorized cars without SIM identifiers',[d['id'] for d in terminals]==[devices[0]] and not any(k in terminals[0] for k in ['iccid','imsi','imei']))
 start='2026-10-08T01:00:00Z';end='2026-10-08T01:10:00Z'
 for d in devices:
  for kind,at in [('wake',start),('sleep_enter',end)]:sql('INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,%s,%s)',(d,a,kind,at))
  for at,lat in [(start,35),(end,35.01)]:sql("INSERT INTO location_records(device_id,user_id,source,fix,lat,lng,recorded_at) VALUES(%s,%s,'l80',true,%s,127,%s)",(d,a,lat,at))
 trips=call(member,'GET',f"/corporate/vehicles/{va['id']}/trips?from=2026-10-08&to=2026-10-08",owner=a);t=trips[0]
 annotation=dict(binding_id=t['binding_id'],source_device_id=devices[0],trip_started_at=t['source_started_at'],purpose='business',driver_staff_id=se['id'])
 ann=call(member,'PATCH',f"/corporate/vehicles/{va['id']}/trips/annotation",annotation,owner=a)
 check('driver department captured',ann['driver_department']=='영업부')
 call(a,'PATCH',f"/corporate/staff/{se['id']}",dict(name='새 이름',department_id=dep2['id']))
 ann=call(member,'PATCH',f"/corporate/vehicles/{va['id']}/trips/annotation",dict(annotation,note='유지'),owner=a)
 check('past driver identity survives profile change',ann['driver_name']=='직원' and ann['driver_department']=='영업부')
 call(a,'PATCH',f"/corporate/vehicles/{va['id']}/trips/annotation",dict(annotation,driver_staff_id=sm['id']))
 call(member,'PATCH',f"/corporate/vehicles/{va['id']}/trips/annotation",annotation,owner=a,expected=403)
 check('member cannot overwrite another driver annotation')
 sql("INSERT INTO subscriptions(user_id,kind,expires_at) VALUES(%s,'corporate_report',now()+interval '1 day')",(a,))
 blob=call(member,'GET','/corporate/report.xlsx?type=nts&month=2026-10',owner=a,binary=True)
 with zipfile.ZipFile(io.BytesIO(blob)) as z:
  names=z.read('xl/workbook.xml').decode();strings=z.read('xl/sharedStrings.xml').decode();check('XLSX forced to authorized vehicles','영업 차량' in names and '지원 차량' not in names and '영업부' in strings)
 call(member,'GET',f"/corporate/report.xlsx?vehicle_ids={vb['id']}&month=2026-10",owner=a,expected=404)
 # A scope with zero cars must never fall back to owner's entire fleet.
 call(a,'PATCH',f"/corporate/staff/{se['id']}",dict(vehicle_ids=[]))
 call(member,'GET','/corporate/report.xlsx?month=2026-10',owner=a,expected=404)
 check('empty vehicle grant never becomes full export',not call(member,'GET','/corporate/vehicles',owner=a))
 call(a,'DELETE',f"/corporate/staff/{sm['id']}");call(manager,'GET','/corporate/vehicles',owner=a,expected=403)
 ann=call(a,'PATCH',f"/corporate/vehicles/{va['id']}/trips/annotation",dict(annotation,driver_staff_id=sm['id'],note='비활성화 후 메모 수정'))
 check('inactive historical driver remains editable without rewriting snapshot',ann['driver_name']=='영업 관리자' and ann['driver_department']=='영업부')
 call(a,'DELETE',f"/corporate/staff/{se['id']}/account");call(member,'GET','/corporate/vehicles',owner=a,expected=403)
 check('disable and unlink revoke already issued JWT access')
 logs=call(a,'GET','/corporate/team-audit');check('audit retains actual actor',any(x['actor_id']==member and x['action']=='delegated_request' for x in logs))
 check('SIM records retain receiving owner',sql('SELECT count(*) FROM location_records WHERE device_id=ANY(%s) AND user_id=%s',(devices,a))==4)
 print(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False))
finally:
 if users:
  cur.execute("SELECT profile->>'car_image_url' FROM fleet_vehicles WHERE owner_id=ANY(%s)",(users,))
  for (url,) in cur.fetchall():
   if url:
    f=(pathlib.Path(__file__).resolve().parent/'private/car-images')/pathlib.Path(url).name
    if f.name.startswith('fleet_'):f.unlink(missing_ok=True)
  for table in ['vehicle_reservations','trip_annotations']:cur.execute('DELETE FROM '+table+' WHERE user_id=ANY(%s)',(users,))
  cur.execute('DELETE FROM fleet_vehicles WHERE owner_id=ANY(%s)',(users,));cur.execute('DELETE FROM staff WHERE user_id=ANY(%s)',(users,))
  cur.execute('DELETE FROM devices WHERE id=ANY(%s)',(devices,));cur.execute('DELETE FROM users WHERE id=ANY(%s)',(users,))
 db.close()
