"""Vehicle/SIM separation regression. Synthetic records, private clone only."""
import base64,datetime,hashlib,hmac,io,json,pathlib,sys,time,urllib.error,urllib.parse,urllib.request,uuid,zipfile
from concurrent.futures import ThreadPoolExecutor
import psycopg2
envpath,base=sys.argv[1:3]
assert base=='http://127.0.0.1:3042'
env={k:v.strip().strip('"').strip("'") for k,v in (l.split('=',1) for l in pathlib.Path(envpath).read_text().splitlines() if '=' in l and not l.startswith('#'))}
assert urllib.parse.urlsplit(env['DATABASE_URL']).path=='/gps_tracker_dev_prodreview_20261020'
db=psycopg2.connect(env['DATABASE_URL']);db.autocommit=True;cur=db.cursor();users=[];devices=[];run=uuid.uuid4().hex
checks=[]
def sql(q,args=()):
 cur.execute(q,args);return cur.fetchone()[0] if cur.description else None
def jwt(user):
 enc=lambda v:base64.urlsafe_b64encode(json.dumps(v).encode()).rstrip(b'=')
 raw=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'sub':str(user),'typ':'access','iat':int(time.time()),'exp':int(time.time())+1800})
 return (raw+b'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),raw,hashlib.sha256).digest()).rstrip(b'=')).decode()
def call(user,method,path,body=None,expected=200,binary=False):
 data=json.dumps(body).encode() if body is not None else None
 r=urllib.request.Request(base+'/gps-tracker/api/v1'+path,data=data,method=method,headers={'Authorization':'Bearer '+jwt(user),'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(r,timeout=70) as res:code=res.status;data=res.read()
 except urllib.error.HTTPError as e:code=e.code;data=e.read()
 if expected is None:return code
 assert code==expected,(method,path,code,data[:250])
 return data if binary else json.loads(data)
def upload(user,path,fields,filebytes,mime):
 boundary='fleet-fixture-'+run
 data=b''
 for name,value in fields.items():data+=(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n').encode()
 data+=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.png"\r\nContent-Type: {mime}\r\n\r\n').encode()+filebytes+f'\r\n--{boundary}--\r\n'.encode()
 req=urllib.request.Request(base+'/gps-tracker/api/v1'+path,data=data,headers={'Authorization':'Bearer '+jwt(user),'Content-Type':'multipart/form-data; boundary='+boundary})
 with urllib.request.urlopen(req) as res:return json.loads(res.read())

def create(owner,name):return call(owner,'POST','/corporate/vehicles',{'name':name,'enabled':True,'profile':{}})
def connect(owner,v,ids,primary=None,expected=200):return call(owner,'PUT',f"/corporate/vehicles/{v['id']}/bindings",dict(device_ids=ids,primary_device_id=primary,updated_at=v['updated_at']),expected=expected)
def vehicle(owner,id):return call(owner,'GET',f'/corporate/vehicles/{id}')
def check(label,condition=True):assert condition,label;checks.append(label)
try:
 for label in ('a','b'):
  users.append(sql("INSERT INTO users(email,password_hash,display_name,phone) VALUES(%s,'test-only','Fleet regression','01000000000') RETURNING id",(f'fleet-{run}-{label}@example.invalid',)))
 a,b=users
 for i in range(2):devices.append(sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'') RETURNING id",(f'fleet-{run}-{i}',a)))
 d1,d2=devices
 va=create(a,'독립 차량 A');vb=create(a,'독립 차량 B');foreign=create(b,'다른 계정 차량')
 check('vehicle without SIM',not va['bindings'])
 call(b,'GET',f"/corporate/vehicles/{va['id']}",expected=404)
 connect(b,foreign,[d1],d1,400);check('foreign vehicle and SIM rejected')
 stale=va.copy();va=connect(a,va,[d1,d2],d1)
 check('multiple SIMs with one primary',len(va['bindings'])==2 and sum(x['is_primary'] for x in va['bindings'])==1)
 connect(a,vb,[d1],d1,409);connect(a,stale,[],None,409);check('overlap and stale version rejected')
 va=connect(a,va,[d1,d2],d2)
 history=call(a,'GET',f"/corporate/vehicles/{va['id']}/bindings")
 check('primary change retains periods',len(history)==4 and len([x for x in history if x['ended_at']])==2)
 # Independent booking works without any SIM; competing HTTP writes cannot double book.
 booking=dict(vehicle_id=vb['id'],driver_staff_id=None,starts_at='2027-01-02T01:00:00Z',ends_at='2027-01-02T02:00:00Z',purpose='Synthetic',status='planned')
 with ThreadPoolExecutor(max_workers=2) as ex:statuses=list(ex.map(lambda _:call(a,'POST','/corporate/vehicle-reservations',booking,expected=None),range(2)))
 check('concurrent reservation exclusion',sorted(statuses)==[200,409])
 rows=call(a,'GET','/corporate/vehicle-reservations?from=2027-01-01T00:00:00Z&to=2027-02-01T00:00:00Z')
 r=rows[0];check('booking uses vehicle identity',r['vehicle_id']==vb['id'] and r['device_id'] is None)
 call(a,'DELETE',f"/corporate/reservations/{r['id']}",expected=404);check('legacy API cannot delete asset booking')
 call(b,'PUT',f"/corporate/vehicle-reservations/{r['id']}",booking,404)
 call(a,'DELETE',f"/corporate/vehicle-reservations/{r['id']}");check('cancellation retained',sql('SELECT status FROM vehicle_reservations WHERE id=%s',(r['id'],))=='cancelled')
 # Seed deterministic historical assignments, leaving all production rows untouched.
 sql('DELETE FROM fleet_vehicle_bindings WHERE owner_id=%s',(a,))
 for v,start,end in [(va,'2026-10-01','2026-10-08T02:05:00Z'),(vb,'2026-10-08T02:05:00Z',None)]:
  sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,is_primary,started_at,ended_at) VALUES(%s,%s,%s,'SIM fixture',true,%s,%s)",(v['id'],a,d1,start,end))
 for hour in (1,2,3):
  start=datetime.datetime(2026,10,8,hour,tzinfo=datetime.timezone.utc);end=start+datetime.timedelta(minutes=10)
  for kind,at in [('wake',start),('sleep_enter',end)]:sql('INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,%s,%s)',(d1,a,kind,at))
  for step in range(3):sql("INSERT INTO location_records(device_id,user_id,source,fix,lat,lng,recorded_at) VALUES(%s,%s,'l80',true,%s,127,%s)",(d1,a,35+step*.001,start+datetime.timedelta(minutes=step*5)))
 suffix='/trips?from=2026-10-08&to=2026-10-08'
 atrips=call(a,'GET',f"/corporate/vehicles/{va['id']}"+suffix);btrips=call(a,'GET',f"/corporate/vehicles/{vb['id']}"+suffix)
 check('old/new vehicles own their historical periods',len(atrips)==2 and len(btrips)==2)
 check('cross-boundary trip excluded from both sums',atrips[-1]['allocation_status']==btrips[0]['allocation_status']=='boundary_review' and atrips[-1]['distance_m'] is None and btrips[0]['distance_m'] is None)
 check('whole trips remain measurable',atrips[0]['distance_m']>0 and btrips[-1]['distance_m']>0)
 # Half-open boundary: a trip ending exactly at handover belongs only to the old car.
 sql("UPDATE fleet_vehicle_bindings SET started_at='2026-10-08T02:10:00Z' WHERE vehicle_id=%s",(vb['id'],))
 sql("UPDATE fleet_vehicle_bindings SET ended_at='2026-10-08T02:10:00Z' WHERE vehicle_id=%s",(va['id'],))
 exact_a=call(a,'GET',f"/corporate/vehicles/{va['id']}"+suffix);exact_b=call(a,'GET',f"/corporate/vehicles/{vb['id']}"+suffix)
 check('exact handover endpoint counted once',len(exact_a)==2 and len(exact_b)==1 and all(t['allocation_status']=='assigned' for t in exact_a+exact_b))
 sql("UPDATE fleet_vehicle_bindings SET ended_at='2026-10-08T02:05:00Z' WHERE vehicle_id=%s",(va['id'],))
 sql("UPDATE fleet_vehicle_bindings SET started_at='2026-10-08T02:05:00Z' WHERE vehicle_id=%s",(vb['id'],))
 image=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=')
 photo=upload(a,f"/corporate/vehicles/{va['id']}/photo",{},image,'image/png')
 doc=upload(a,f"/corporate/vehicles/{va['id']}/documents",{'kind':'registration'},image,'image/png')
 check('private vehicle photo readable',call(a,'GET',f"/corporate/vehicles/{va['id']}/photo",binary=True)==image)
 call(b,'GET',f"/corporate/vehicles/{va['id']}/photo",expected=404)
 call(b,'GET',f"/documents/{doc['id']}/download",expected=404);check('photo and document isolated from another account')
 original_count=sql('SELECT count(*) FROM location_records WHERE device_id=%s AND user_id=%s',(d1,a))
 # Owner release automatically closes bindings, not the asset or history.
 sql('UPDATE devices SET owner_id=%s WHERE id=%s',(b,d1))
 check('owner change ends active connections',not vehicle(a,vb['id'])['bindings'])
 check('vehicle documents retained after SIM transfer',call(a,'GET',f"/documents/{doc['id']}/download",binary=True)==image)
 call(a,'DELETE',f"/documents/{doc['id']}")
 check('old account history retained',call(a,'GET',f"/corporate/vehicles/{va['id']}"+suffix)==atrips)
 call(b,'GET',f"/corporate/vehicles/{va['id']}"+suffix,expected=404)
 check('telemetry identity and samples unchanged',sql('SELECT count(*) FROM location_records WHERE device_id=%s AND user_id=%s',(d1,a))==original_count)
 # Historical annotations stay editable by the old vehicle owner after SIM release.
 trip=atrips[0]
 call(a,'PATCH',f"/corporate/vehicles/{va['id']}/trips/annotation",dict(binding_id=trip['binding_id'],source_device_id=d1,trip_started_at=trip['source_started_at'],purpose='business',note='역사 보존'))
 check('historical annotation survives SIM ownership change',sql('SELECT purpose FROM trip_annotations WHERE device_id=%s AND user_id=%s',(d1,a))=='business')
 # Reusing the SIM for the other account cannot expose the old account's events.
 foreign=connect(b,foreign,[d1],d1)
 check('new owner cannot inherit old telemetry',not call(b,'GET',f"/corporate/vehicles/{foreign['id']}"+suffix))
 # Stats include full primary days only, independent of current SIM ownership.
 sql("INSERT INTO daily_stats(device_id,user_id,date,fix_count,distance_m,last_fix_at) VALUES(%s,%s,'2026-10-07',3,600,'2026-10-07T02:00:00Z')",(d1,a))
 stat=call(a,'GET','/corporate/vehicle-stats')['per_device']
 check('statistics key is vehicle id',set(x['vehicle_id'] for x in stat)=={va['id'],vb['id']})
 check('historical full-day distance belongs only to old vehicle',next(x['total_distance_m'] for x in stat if x['vehicle_id']==va['id'])==600 and next(x['total_distance_m'] for x in stat if x['vehicle_id']==vb['id'])==0)
 sql("INSERT INTO subscriptions(user_id,kind,expires_at) VALUES(%s,'corporate_report',now()+interval '1 day')",(a,))
 blob=call(a,'GET',f"/corporate/report.xlsx?scope=vehicles&type=nts&month=2026-10&vehicle_ids={va['id']}",binary=True)
 with zipfile.ZipFile(io.BytesIO(blob)) as z:
  strings=z.read('xl/sharedStrings.xml').decode();names=z.read('xl/workbook.xml').decode();check('vehicle XLSX includes boundary review and asset',('합계 제외' in strings and '독립 차량 A' in names))
 check('audit exists',len(call(a,'GET',f"/corporate/vehicles/{va['id']}/audit"))>=3)
 print(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False))
finally:
 if users:
  cur.execute("SELECT profile->>'car_image_url' FROM fleet_vehicles WHERE owner_id=ANY(%s)",(users,))
  for (url,) in cur.fetchall():
   if url:
    f=pathlib.Path('/home/mmm/gps-artifacts/fleet-assets-20261029-r1/private/car-images')/pathlib.Path(url).name
    if f.name.startswith('fleet_'):f.unlink(missing_ok=True)
  cur.execute('DELETE FROM vehicle_reservations WHERE user_id=ANY(%s)',(users,))
  cur.execute('DELETE FROM fleet_vehicles WHERE owner_id=ANY(%s)',(users,))
  cur.execute('DELETE FROM devices WHERE id=ANY(%s)',(devices,))
  cur.execute('DELETE FROM users WHERE id=ANY(%s)',(users,))
 db.close()
