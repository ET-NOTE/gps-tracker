import base64,datetime,hashlib,hmac,json,os,time,urllib.request,urllib.error
import psycopg2
DSN='postgres://postgres:review147-test-only@127.0.0.1/gps_tracker_dev_prodreview_20261020'
JWT='review147-synthetic-only'
db=psycopg2.connect(DSN);db.autocommit=True
def sql(q,a=()):
 with db.cursor() as c:
  c.execute(q,a);return c.fetchall() if c.description else None
def call(u,method,path,body=None,owner=None):
 enc=lambda x:base64.urlsafe_b64encode(json.dumps(x).encode()).rstrip(b'=')
 raw=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'sub':str(u),'typ':'access','iat':int(time.time()),'exp':int(time.time())+600})
 token=(raw+b'.'+base64.urlsafe_b64encode(hmac.new(JWT.encode(),raw,hashlib.sha256).digest()).rstrip(b'=')).decode()
 headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}
 if owner:headers['X-Fleet-Owner']=str(owner)
 req=urllib.request.Request('http://127.0.0.1:3042/gps-tracker/api/v1'+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
 try:
  with urllib.request.urlopen(req,timeout=30) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
checks=[]
def ok(label,cond):
 assert cond,label
 checks.append(label)
ids=[sql("INSERT INTO users(email,password_hash,display_name,phone) VALUES(%s,'synthetic','Synthetic147','01000000000') RETURNING id",('review147-'+x+'@example.invalid',))[0][0] for x in ('owner','admin','member','outsider')]
owner,admin,member,outsider=ids
staff=[]
for u,role in ((admin,'admin'),(member,'member')):
 sid=sql("INSERT INTO staff(user_id,name,active,access_role) VALUES(%s,%s,true,%s) RETURNING id",(owner,'Synthetic '+role,role))[0][0];staff.append(sid)
 sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(owner,sid,u))
devices=[sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'') RETURNING id",('review147-'+str(i),owner))[0][0] for i in range(2)]
vehicles=[]
for i in range(2):
 code,v=call(owner,'POST','/corporate/vehicles',{'name':'Synthetic147 '+str(i),'enabled':True,'profile':{}});assert code==200;vehicles.append(v)
now=datetime.datetime.now(datetime.timezone.utc);start=(now-datetime.timedelta(days=1)).replace(hour=1,minute=0,second=0,microsecond=0)
for i,(v,d) in enumerate(zip(vehicles,devices)):
 sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,is_primary,started_at) VALUES(%s,%s,%s,'Synthetic147',true,%s)",(v['id'],owner,d,start-datetime.timedelta(days=1)))
 at=start+datetime.timedelta(hours=i)
 for kind,minute in (('wake',0),('sleep_enter',10)):
  sql('INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,%s,%s)',(d,owner,kind,at+datetime.timedelta(minutes=minute)))
 for step in range(3):
  sql("INSERT INTO location_records(device_id,user_id,source,fix,lat,lng,recorded_at) VALUES(%s,%s,'l80',true,%s,127,%s)",(d,owner,35+i*.1+step*.001,at+datetime.timedelta(minutes=step*5)))
date=start.date().isoformat();path=lambda v:f"/corporate/vehicles/{v['id']}"
trip_path=lambda v:path(v)+'/trips?from='+date+'&to='+date
before=[call(owner,'GET',trip_path(v))[1] for v in vehicles]
ok('one complete historical trip per vehicle before actual swap',all(len(rows)==1 and rows[0]['allocation_status']=='assigned' for rows in before))
payload={'vehicles':[{'vehicle_id':v['id'],'updated_at':v['updated_at'],'device_ids':[devices[1-i]],'primary_device_id':devices[1-i]} for i,v in enumerate(vehicles)]}
for who in (member,outsider):
 status,_=call(who,'PUT','/corporate/vehicles/bindings/batch',payload,owner)
 ok('delegated '+('member' if who==member else 'outsider')+' cannot swap',status==403)
status,result=call(admin,'PUT','/corporate/vehicles/bindings/batch',payload,owner)
ok('delegated company admin atomically swaps both vehicles',status==200 and result=={'updated':2})
after=[call(owner,'GET',trip_path(v))[1] for v in vehicles]
ok('real batch swap preserves original historical trip JSON on both vehicles',before==after)
current=[call(owner,'GET',path(v))[1] for v in vehicles]
ok('new primaries are exchanged at one boundary',current[0]['bindings'][0]['device_id']==devices[1] and current[1]['bindings'][0]['device_id']==devices[0] and current[0]['updated_at']==current[1]['updated_at'])
ok('original source events and positions retained',sql('SELECT count(*) FROM location_records WHERE user_id=%s',(owner,))==[(6,)] and sql('SELECT count(*) FROM events WHERE user_id=%s',(owner,))==[(4,)])
v=current[0]
body={k:v[k] for k in ('name','license_plate','car_model','department','department_id','manager_staff_id','enabled','profile','updated_at')}
body['manager_staff_id']=staff[1]
code,v=call(owner,'PUT',path(v),body);assert code==200
sql('UPDATE staff SET active=false WHERE id=%s',(staff[1],))
body={k:v[k] for k in ('name','license_plate','car_model','department','department_id','manager_staff_id','enabled','profile','updated_at')}
body['profile']={**body['profile'],'next_service_date':'2026-12-01'}
code,result=call(owner,'PUT',path(v),body)
ok('schedule-only PUT preserves an unchanged inactive manager',code==200 and result['manager_staff_id']==staff[1])
ok('schedule saved while remaining non-schedule fields stay unchanged',result['profile']['next_service_date']=='2026-12-01' and all(result[k]==v[k] for k in ('name','license_plate','car_model','department','department_id','manager_staff_id','enabled')))
print(json.dumps({'passed':len(checks),'checks':checks,'inactive_manager_hypothesis':'not reproduced; unchanged assignment is allowed','synthetic_only':True},ensure_ascii=False))
