"""Review/correct/restore trip quality, role isolation and SIM continuity. Private clone only."""
import base64,datetime,hashlib,hmac,io,json,pathlib,sys,time,urllib.error,urllib.parse,urllib.request,uuid,zipfile
from concurrent.futures import ThreadPoolExecutor
import psycopg2
import xml.etree.ElementTree as ET
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
  users.append(sql("INSERT INTO users(email,password_hash,display_name,phone) VALUES(%s,'test-only','Quality regression','01000000000') RETURNING id",(f'quality-{run}-{label}@example.invalid',)))
 a,admin,manager,member,outsider=users
 sql("INSERT INTO subscriptions(user_id,kind,expires_at) VALUES(%s,'corporate_report',now()+interval '1 day')",(a,))
 dep=item(a,'department','영업팀');va=vehicle(a,'검증 차량',dep['id'])
 sa=staff(a,'관리자',access_role='admin');sm=staff(a,'직원',department_id=dep['id'],vehicle_ids=[va['id']],all_vehicles=False);sg=staff(a,'부서장',department_id=dep['id'],access_role='department_manager')
 for s,u in [(sa,admin),(sm,member),(sg,manager)]:accept(a,s,u)
 t0=datetime.datetime(2026,10,26,tzinfo=datetime.timezone.utc);day='2026-10-26'
 device=sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'') RETURNING id",('quality-'+run,a));devices.append(device)
 bid=sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,is_primary,started_at) VALUES(%s,%s,%s,'Quality fixture',true,%s) RETURNING id",(va['id'],a,device,t0-datetime.timedelta(days=1)))
 for hour in [0,2,4,6,8]:
  for kind,minute in [('wake',0),('sleep_enter',20)]:sql('INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,%s,%s)',(device,a,kind,t0+datetime.timedelta(hours=hour,minutes=minute)))
  for minute in range(0,21,5):
   if hour==4 and minute not in [0,20]:continue
   lat=37 if hour==6 else 37+minute*0.001
   sql("INSERT INTO location_records(device_id,user_id,source,fix,lat,lng,recorded_at) VALUES(%s,%s,'l80',true,%s,127,%s)",(device,a,lat,t0+datetime.timedelta(hours=hour,minutes=minute)))
 sql("INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,'wake',%s)",(device,a,t0+datetime.timedelta(hours=10)))
 for minute in [0,5,10]:sql("INSERT INTO location_records(device_id,user_id,source,fix,lat,lng,recorded_at) VALUES(%s,%s,'l80',true,%s,127,%s)",(device,a,37+minute*.001,t0+datetime.timedelta(hours=10,minutes=minute)))
 root=f"/corporate/vehicles/{va['id']}"
 def trips():return call(a,'GET',root+f'/trips?from={day}&to={day}')
 def export_total():
  blob=call(a,'GET',f"/corporate/report.xlsx?scope=vehicles&type=nts&month=2026-10&vehicle_ids={va['id']}",binary=True)
  with zipfile.ZipFile(io.BytesIO(blob)) as z:
   ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
   strings=[''.join(si.itertext()) for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si',ns)]
   cells={}
   for cell in ET.fromstring(z.read('xl/worksheets/sheet1.xml')).findall('.//s:sheetData/s:row/s:c',ns):
    val=cell.find('s:v',ns)
    if val is not None:cells[cell.attrib['r']]=strings[int(val.text)] if cell.attrib.get('t')=='s' else float(val.text)
   key=next(k for k,v in cells.items() if isinstance(v,str) and v.startswith('⑪'))
   expected=sum(round(t['distance_m']/1000,2) for t in trips() if t['quality']['report_included'])
   return abs(cells['E'+key[1:]]-expected)<.001
 def key(t):return dict(source_device_id=device,binding_id=bid,trip_started_at=t['source_started_at'])
 ts=trips();assert len(ts)==6,len(ts)
 original=json.loads(json.dumps(ts));raw_count=sql('SELECT count(*) FROM location_records WHERE device_id=%s',(device,));event_count=sql('SELECT count(*) FROM events WHERE device_id=%s',(device,))
 check('valid closed motion is confirmed',ts[0]['quality']['status']=='confirmed')
 check('missing last end is never permanent driving',ts[-1]['quality']['status']=='end_missing')
 check('large gaps and zero need review',ts[2]['quality']['status']=='review' and ts[2]['quality']['gap_count']==1 and ts[3]['quality']['zero_reason']=='stationary_or_short')
 check('XLSX excludes unconfirmed distances using the same policy',export_total())
 ev=call(member,'POST',root+'/trips/evidence',dict(from_=day),owner=a,expected=422,binary=True)
 ep={'from':day,'to':day,'key':key(ts[2])};ev=call(member,'POST',root+'/trips/evidence',ep,owner=a)
 check('evidence has actual coordinates and bounded gaps',ev['point_count']==2 and len(ev['gaps'])==1 and ev['calculated_distance_m']==0)
 call(outsider,'POST',root+'/trips/evidence',ep,expected=404)
 call(member,'GET',root+'/trips/corrections',owner=a,expected=403)
 check('evidence and history role isolation')
 def body(rows,action='confirm',**kw):return {'from':day,'to':day,'trips':[key(t) for t in rows],'action':action,'reason':'실측 자료 검토',**kw}
 def correction(p,user=a,expected=200):return call(user,'POST',root+'/trips/corrections',p,owner=a if user!=a else None,expected=expected)
 def apply(p,user=a):pr=correction(p,user);return correction(dict(p,preview_token=pr['preview_token']),user)
 p=body([ts[2]]);correction(p,member,403);pr=correction(p)
 check('preview writes nothing',sql('SELECT count(*) FROM fleet_trip_corrections WHERE owner_id=%s',(a,))==0 and pr['after'][0]['quality']['report_included'])
 correction(dict(p,preview_token=pr['preview_token']),manager,409)
 applied=apply(p,manager)
 # Actor is part of preview, so another actor requires its own preview.
 check('review confirmed and actual actor audited',trips()[2]['quality']['status']=='confirmed' and sql('SELECT actor_id FROM fleet_trip_corrections WHERE id=%s',(applied['id'],))==manager)
 correction(dict(p,preview_token=pr['preview_token']),expected=400)
 call(a,'POST',root+f"/trips/corrections/{applied['id']}/restore",{'reason':'원본으로 재검토'})
 check('restore exposes original and retains audit',trips()[2]['quality']['status']=='review' and sql('SELECT reverted_at IS NOT NULL FROM fleet_trip_corrections WHERE id=%s',(applied['id'],)))
 # Existing annotation remains on the first split part, no duplicate fuel.
 ann=dict(key(ts[0]),purpose='business',driver_staff_id=sm['id'],fuel_cost=12345,fuel_liters=4,note='원본 메모')
 call(a,'PATCH',root+'/trips/annotation',ann)
 p=body([ts[0]],'split',split_at=(t0+datetime.timedelta(minutes=10)).isoformat())
 pr=correction(p);check('split preview does not copy money',pr['after'][0]['annotation']['fuel_cost']==12345 and pr['after'][1]['annotation'] is None)
 split=correction(dict(p,preview_token=pr['preview_token']));current=trips()
 check('split has no original duplicate',len(current)==7 and len([t for t in current if t.get('correction_id')==split['id']])==2 and sum((t.get('annotation') or {}).get('fuel_cost') or 0 for t in current)==12345)
 call(a,'PATCH',root+'/trips/annotation',dict(key(current[1]),purpose='commute',driver_staff_id=sm['id']))
 check('split output can be annotated independently',trips()[1]['annotation']['purpose']=='commute')
 check('XLSX includes split outputs once without original duplication',export_total())
 call(a,'POST',root+f"/trips/corrections/{split['id']}/restore",{'reason':'분할 취소'})
 check('restoration preserves source annotation and hides split output',len(trips())==6 and trips()[0]['annotation']['fuel_cost']==12345)
 # Two adjacent unannotated trips merge without computing across the unobserved gap.
 current=trips();p=body(current[1:3],'merge');pr=correction(p)
 check('merge sum does not bridge missing GPS',abs(pr['after'][0]['distance_m']-sum(t['distance_m'] for t in current[1:3]))<0.001)
 merged=correction(dict(p,preview_token=pr['preview_token']));check('merge replaces both originals once',len(trips())==5)
 call(a,'POST',root+f"/trips/corrections/{merged['id']}/restore",{'reason':'병합 취소'})
 correction(body([trips()[0],trips()[1]],'merge'),expected=400)
 correction(body([trips()[1],trips()[3]],'merge'),expected=400)
 check('annotated and nonadjacent merges rejected')
 correction(body([ts[-1]]),expected=400)
 p=body([trips()[-1]],'adjust',ended_at=(t0+datetime.timedelta(hours=10,minutes=10)).isoformat(),distance_m=1000)
 adjusted=apply(p);check('missing end can be explicitly corrected with reason',trips()[-1]['distance_m']==1000 and trips()[-1]['quality']['report_included'])
 correction(body([ts[1]],'adjust',ended_at=(t0+datetime.timedelta(hours=3)).isoformat()),expected=400)
 correction(body([ts[1]],'adjust',ended_at=ts[1]['ended_at'],distance_m=-1),expected=400)
 check('correction cannot extend source interval or accept negative distances')
 # New measurements inside a corrected interval make it unconfirmed, not silently stale.
 sql("INSERT INTO location_records(device_id,user_id,source,fix,lat,lng,recorded_at) VALUES(%s,%s,'l80',true,37.002,127,%s)",(device,a,t0+datetime.timedelta(hours=10,minutes=2)))
 check('late raw evidence marks correction for review',trips()[-1]['quality']['source_changed'] and not trips()[-1]['quality']['report_included'])
 check('XLSX excludes corrections invalidated by late evidence',export_total())
 call(a,'POST',root+f"/trips/corrections/{adjusted['id']}/restore",{'reason':'신규 위치 반영'})
 # Same preview applies once under concurrent requests.
 p=body([trips()[3]]);pr=correction(p)
 results=list(ThreadPoolExecutor(2).map(lambda _:correction(dict(p,preview_token=pr['preview_token']),expected=None),range(2)))
 check('simultaneous correction has one winner',sorted(results) in [[200,400],[200,409]])
 # Modified binding after preview blocks the update.
 p=body([trips()[1]]);pr=correction(p)
 sql('UPDATE fleet_vehicle_bindings SET ended_at=%s WHERE id=%s',(t0+datetime.timedelta(hours=2,minutes=10),bid))
 correction(dict(p,preview_token=pr['preview_token']),expected=400)
 sql('UPDATE fleet_vehicle_bindings SET ended_at=NULL WHERE id=%s',(bid,))
 check('SIM binding boundary cannot be silently corrected')
 history=call(a,'GET',root+'/trips/corrections')['rows'];check('history retains original outputs reasons and restoration',len(history)>=5 and all(r['sources'] and r['outputs'] and r['reason'] for r in history))
 call(outsider,'POST',root+f"/trips/corrections/{split['id']}/restore",{'reason':'부정 요청'},expected=404)
 call(member,'POST',root+f"/trips/corrections/{split['id']}/restore",{'reason':'권한 없음'},owner=a,expected=403)
 check('restore requires vehicle and manager permission')
 check('raw SIM records and events are never rewritten',sql('SELECT count(*) FROM location_records WHERE device_id=%s',(device,))==raw_count+1 and sql('SELECT count(*) FROM events WHERE device_id=%s',(device,))==event_count)
 print(json.dumps({'quality_checks':len(checks),'checks':checks},ensure_ascii=False))
finally:
 if users:sql('DELETE FROM fleet_trip_corrections WHERE owner_id=ANY(%s)',(users,))
 if devices:sql('DELETE FROM devices WHERE id=ANY(%s)',(devices,))
 if users:sql('DELETE FROM users WHERE id=ANY(%s)',(users,))
 db.close()
