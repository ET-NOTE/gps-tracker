"""Company expense ledger regression. Private clone only."""
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

def payload(category,**kw):return dict(request_id=str(uuid.uuid4()),spent_on=day,category_id=category,staff_id=None,vehicle_id=None,amount_krw=50000,payment_method='company_card',note='검증용 비용',**kw)
def save(user,p,owner=None):return call(user,'POST','/corporate/expenses',p,owner=owner)
def edit(user,r,p,owner=None,expected=200):return call(user,'PUT',f"/corporate/expenses/{r['id']}",dict(p,updated_at=r['updated_at']),owner=owner,expected=expected)
def detail(user,r,owner=None):return call(user,'GET',f"/corporate/expenses/{r['id']}",owner=owner)
def review(user,r,status,owner=None,expected=200):return call(user,'POST',f"/corporate/expenses/{r['id']}/review",dict(status=status,note='검증 처리',updated_at=r['updated_at']),owner=owner,expected=expected)
def rows(user,owner=None,extra=''):return call(user,'GET',f'/corporate/expenses?from={day}&to={day}'+extra,owner=owner)['items']
def receipt(user,r,data=b'%PDF-1.7\nfixture',owner=None,expected=200):
 boundary='expense-'+run
 body=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.pdf"\r\nContent-Type: application/pdf\r\n\r\n').encode()+data+f'\r\n--{boundary}--\r\n'.encode()
 headers={'Authorization':'Bearer '+jwt(user),'Content-Type':'multipart/form-data; boundary='+boundary}
 if owner:headers['X-Fleet-Owner']=str(owner)
 req=urllib.request.Request(base+f"/gps-tracker/api/v1/corporate/expenses/{r['id']}/receipts",data=body,headers=headers)
 try:
  with urllib.request.urlopen(req,timeout=30) as res:status=res.status;result=res.read()
 except urllib.error.HTTPError as e:status=e.code;result=e.read()
 assert status==expected,(status,result[:160]);return json.loads(result)

try:
 day=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).date().isoformat()
 for label in ['owner','admin','manager','member','outsider']:
  users.append(sql("INSERT INTO users(email,password_hash,display_name,phone) VALUES(%s,'test-only','Expense regression','01000000000') RETURNING id",(f'expenses-{run}-{label}@example.invalid',)))
 a,admin,manager,member,outsider=users
 dep=item(a,'department','영업팀');otherdep=item(a,'department','다른 부서')
 va=vehicle(a,'영업차량',dep['id']);vb=vehicle(a,'다른 차량',otherdep['id'])
 sa=staff(a,'관리자',access_role='admin');sm=staff(a,'직원',department_id=dep['id'],all_vehicles=False,vehicle_ids=[va['id']]);sg=staff(a,'부서장',department_id=dep['id'],access_role='department_manager');so=staff(a,'다른 부서',department_id=otherdep['id'])
 for s,u in [(sa,admin),(sm,member),(sg,manager)]:accept(a,s,u)
 cats=call(a,'GET','/corporate/expense-categories');fuel=next(c for c in cats if c['kind']=='fuel');category=next(c for c in cats if c['name']=='숙박비');foreign=call(outsider,'GET','/corporate/expense-categories')[0]
 check('default groups and expense categories seeded for new account',len(cats)==9)
 cp=dict(name='통신비',parent_id=category['parent_id'],kind='expense',active=True)
 custom=call(a,'POST','/corporate/expense-categories',cp)
 call(member,'POST','/corporate/expense-categories',cp,owner=a,expected=403)
 call(a,'POST','/corporate/expense-categories',cp,expected=409)
 call(a,'POST','/corporate/expense-categories',dict(cp,parent_id=foreign['id']),expected=400)
 check('category role, foreign parent and duplicate names guarded')
 p=payload(category['id']);r=save(a,p)
 check('general expense needs neither vehicle nor staff',r['vehicle_id'] is None and r['status']=='pending')
 with ThreadPoolExecutor(max_workers=2) as pool:retries=list(pool.map(lambda _:save(a,p),range(2)))
 check('concurrent retried registration creates one row',{x['id'] for x in retries}=={r['id']} and len(rows(a))==1)
 call(a,'POST','/corporate/expenses',dict(p,amount_krw=50001),expected=409)
 for bad in [dict(p,request_id='bad'),dict(p,request_id=str(uuid.uuid4()),amount_krw=-1),dict(p,request_id=str(uuid.uuid4()),amount_krw=1000000001),dict(p,request_id=str(uuid.uuid4()),category_id=foreign['id']),dict(p,request_id=str(uuid.uuid4()),payment_method='bitcoin')]:call(a,'POST','/corporate/expenses',bad,expected=400)
 check('invalid amount, category, payment and request key rejected')
 mp=dict(payload(custom['id']),staff_id=sm['id'],vehicle_id=va['id'])
 mr=save(member,mp,owner=a)
 call(member,'POST','/corporate/expenses',dict(mp,request_id=str(uuid.uuid4()),staff_id=so['id']),owner=a,expected=403)
 call(member,'POST','/corporate/expenses',dict(mp,request_id=str(uuid.uuid4()),vehicle_id=vb['id']),owner=a,expected=404)
 call(member,'GET',f"/corporate/expenses/{r['id']}",owner=a,expected=404)
 call(outsider,'GET',f"/corporate/expenses/{mr['id']}",expected=404)
 check('member and other-company isolation',len(rows(member,owner=a))==1)
 review(member,mr,'approved',owner=a,expected=403)
 approved=review(manager,mr,'approved',owner=a)
 edit(member,approved,mp,owner=a,expected=403)
 receipt(member,approved,owner=a,expected=403)
 check('department manager approves assigned staff expense; approved rows immutable',approved['status']=='approved')
 ap=dict(payload(category['id']),staff_id=sa['id']);ar=save(admin,ap,owner=a)
 review(admin,ar,'approved',owner=a,expected=403)
 ar=review(a,ar,'approved')
 check('self-review blocked except company owner',ar['status']=='approved')
 rejected=review(a,r,'rejected');r=edit(a,rejected,p)
 check('editing rejected expense resubmits for approval',r['status']=='pending' and r['reviewed_at'] is None)
 edit(a,rejected,p,expected=409)
 cancelled=review(a,approved,'cancelled');check('cancellation removes approved amount without deleting history',cancelled['status']=='cancelled' and len(detail(a,cancelled)['history'])>=3)
 updatedcat=call(a,'PUT',f"/corporate/expense-categories/{custom['id']}",dict(cp,name='통신료 변경',active=False,updated_at=custom['updated_at']))
 check('renamed category preserves historic meaning',detail(a,mr)['expense']['category_name']=='통신비')
 call(a,'POST','/corporate/expenses',payload(custom['id']),expected=400)
 check('disabled category cannot create a new expense')
 gp=dict(payload(category['id']),staff_id=so['id'],vehicle_id=vb['id']);gr=save(a,gp)
 call(manager,'GET',f"/corporate/expenses/{gr['id']}",owner=a,expected=404)
 call(manager,'GET',f'/corporate/expenses?vehicle_id={vb["id"]}',owner=a,expected=404)
 check('department scope also enforced on detail and filters',gr['id'] not in [x['id'] for x in rows(manager,owner=a)])
 file=receipt(a,r);again=receipt(a,r)
 check('receipt retry deduplicated',file['id']==again['id'])
 call(outsider,'GET',f"/corporate/expenses/{r['id']}/receipts/{file['id']}",expected=404)
 receipt(a,r,b'<html>not-a-pdf',expected=400)
 receipt(a,r,b'%PDF-'+b'0'*(5*1024*1024),expected=400)
 check('private receipt access, byte type and size guards')
 data=call(a,'GET',f"/corporate/expenses/{r['id']}/receipts/{file['id']}",binary=True);assert data.startswith(b'%PDF-')
 call(a,'DELETE',f"/corporate/expenses/{r['id']}/receipts/{file['id']}")
 call(a,'GET',f"/corporate/expenses/{r['id']}/receipts/{file['id']}",expected=404)
 check('removed receipt bytes and audit retained',sql('SELECT octet_length(content)>0 AND removed_at IS NOT NULL FROM fleet_expense_receipts WHERE id=%s',(file['id'],)))
 r=detail(a,r)['expense']
 for n in range(5):receipt(a,r,b'%PDF-1.7 '+str(n).encode())
 receipt(a,r,b'%PDF-1.7 sixth',expected=400)
 check('receipt count limit enforced')
 # A real computed SIM trip, wholly inside the primary vehicle assignment.
 t0=datetime.datetime.now(datetime.timezone.utc).replace(hour=0,minute=0,second=0,microsecond=0)-datetime.timedelta(days=1)
 device=sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'') RETURNING id",('expense-'+run,a));devices.append(device)
 bid=sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,is_primary,started_at) VALUES(%s,%s,%s,'expense fixture',true,%s) RETURNING id",(va['id'],a,device,t0-datetime.timedelta(days=1)))
 for kind,minute in [('wake',1),('sleep_enter',20)]:sql('INSERT INTO events(device_id,user_id,kind,occurred_at) VALUES(%s,%s,%s,%s)',(device,a,kind,t0+datetime.timedelta(minutes=minute)))
 for minute,lat in [(1,37),(10,37.01),(20,37.02)]:sql("INSERT INTO location_records(device_id,user_id,source,fix,lat,lng,recorded_at) VALUES(%s,%s,'l80',true,%s,127,%s)",(device,a,lat,t0+datetime.timedelta(minutes=minute)))
 tripday=(t0+datetime.timedelta(hours=9)).date().isoformat()
 def trips():return call(a,'GET',f"/corporate/vehicles/{va['id']}/trips?from={tripday}&to={tripday}")
 trip=trips()[0];start=trip['source_started_at']
 annotation=dict(trip_started_at=start,binding_id=bid,source_device_id=device,purpose='business',driver_staff_id=sm['id'],fuel_cost=50000)
 call(a,'PATCH',f"/corporate/vehicles/{va['id']}/trips/annotation",annotation)
 fp=dict(payload(fuel['id']),staff_id=sm['id'],vehicle_id=va['id'],source_device_id=device,binding_id=bid,trip_started_at=start)
 call(a,'PATCH',f"/corporate/vehicles/{va['id']}/trips/annotation",dict(annotation,driver_staff_id=sg['id']))
 call(member,'POST','/corporate/expenses',fp,owner=a,expected=403)
 check('member cannot adopt another driver fuel on a shared vehicle')
 call(a,'PATCH',f"/corporate/vehicles/{va['id']}/trips/annotation",annotation)
 fr=save(a,fp)
 check('legacy fuel adopted once; pending cost excluded from trip',trips()[0]['annotation']['fuel_cost'] is None and sql('SELECT fuel_cost IS NULL AND fuel_expense_id=%s FROM trip_annotations WHERE user_id=%s AND device_id=%s',(fr['id'],a,device)))
 call(a,'POST','/corporate/expenses',dict(fp,request_id=str(uuid.uuid4())),expected=409)
 call(a,'PATCH',f"/corporate/vehicles/{va['id']}/trips/annotation",annotation,expected=409)
 call(a,'PATCH',f"/corporate/vehicles/{va['id']}/trips/annotation",dict(annotation,fuel_cost=None,note='주유비 유지'))
 fr=review(a,fr,'approved');check('approved trip displays the single ledger amount',trips()[0]['annotation']['fuel_cost']==50000)
 # General costs share a trip with fuel without adopting or clearing fuel money.
 gp=dict(fp,request_id=str(uuid.uuid4()),category_id=category['id'],amount_krw=12000)
 general=save(a,gp);second=save(a,dict(gp,request_id=str(uuid.uuid4()),amount_krw=3000))
 check('multiple general expenses coexist with one fuel link',general['trip_started_at']==start and second['id']!=general['id'] and trips()[0]['annotation']['fuel_cost']==50000)
 with ThreadPoolExecutor(max_workers=2) as pool:general_retries=list(pool.map(lambda _:save(a,gp),range(2)))
 check('linked general cost retry remains exactly once',{r['id'] for r in general_retries}=={general['id']})
 call(member,'POST','/corporate/expenses',dict(gp,request_id=str(uuid.uuid4()),staff_id=sm['id'],vehicle_id=vb['id']),owner=a,expected=404)
 call(a,'POST','/corporate/expenses',dict(gp,request_id=str(uuid.uuid4()),vehicle_id=vb['id']),expected=400)
 call(outsider,'POST','/corporate/expenses',dict(gp,request_id=str(uuid.uuid4())),expected=400)
 check('general trip links enforce vehicle binding and tenant scope')
 edit(a,general,dict(gp,category_id=fuel['id']),expected=400)
 check('linked cost cannot switch into fuel and overwrite its annotation')
 general=edit(a,general,dict(gp,amount_krw=15000));general=review(a,general,'approved')
 check('general expense approval keeps fuel distinct',general['amount_krw']==15000 and trips()[0]['annotation']['fuel_cost']==50000)
 general=review(a,general,'cancelled');second=review(a,second,'cancelled')
 check('general expense cancellation never clears another fuel expense',trips()[0]['annotation']['fuel_cost']==50000)
 fr=review(a,fr,'cancelled');check('cancelled fuel is excluded and link released',trips()[0]['annotation']['fuel_cost'] is None and trips()[0]['annotation']['fuel_expense_id'] is None)
 fr2=save(a,dict(fp,request_id=str(uuid.uuid4())));check('cancelled trip can be registered anew without double active link',fr2['id']!=fr['id'])
 check('SIM raw data and physical identity unchanged',sql('SELECT count(*) FROM location_records WHERE device_id=%s AND user_id=%s',(device,a))==3)
 check('every mutation retains actual actor audit',sql("SELECT count(*) FROM fleet_expense_audit WHERE owner_id=%s AND actor_id=%s",(a,member))>=1)
 call(a,'GET','/corporate/expenses?from=2020-01-01&to=2026-10-29',expected=400)
 call(a,'GET','/corporate/expenses?status=unknown',expected=400)
 check('invalid query never silently broadens results')
 print(json.dumps({'expense_checks':len(checks),'checks':checks},ensure_ascii=False))
finally:
 # Expenses reference staff and vehicles; remove the isolated fixture ledger first.
 if users:
  sql('UPDATE trip_annotations SET fuel_expense_id=NULL WHERE user_id=ANY(%s)',(users,))
  sql('DELETE FROM fleet_expenses WHERE owner_id=ANY(%s)',(users,))
 if devices:sql('DELETE FROM devices WHERE id=ANY(%s)',(devices,))
 if users:sql('DELETE FROM users WHERE id=ANY(%s)',(users,))
 db.close()
