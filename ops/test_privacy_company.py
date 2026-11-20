"""No production mode: real API/DB workflow in an internal Docker network only."""
import concurrent.futures,csv,hashlib,io,json,pathlib,subprocess,time,urllib.error,urllib.request,uuid
from datetime import datetime,timedelta,timezone
import psycopg2

NETWORK='gps-account-closure-test-20261105';DB='gps-account-closure-db-20261105';API='gps-account-closure-api-20261105'
inspect=lambda kind,name:json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NETWORK)['Internal']
di,ai=inspect('container',DB),inspect('container',API)
cfg=dict(v.split('=',1) for v in ai['Config']['Env'] if '=' in v)
assert cfg['APP_ENV']=='test' and cfg['DATABASE_URL']=='postgres://postgres:closure-test-only@closure-db:5432/gps_closure_test'
binary=pathlib.Path(__file__).parent/'out/gps-tracker-api';digest=hashlib.sha256(binary.read_bytes()).hexdigest()
assert subprocess.check_output(['docker','exec',API,'sha256sum','/proc/1/exe']).decode().split()[0]==digest
base=f"http://{ai['NetworkSettings']['Networks'][NETWORK]['IPAddress']}:3043/gps-tracker/api/v1"
db=psycopg2.connect(f"postgres://postgres:closure-test-only@{di['NetworkSettings']['Networks'][NETWORK]['IPAddress']}/gps_closure_test");db.autocommit=True
tag=uuid.uuid4().hex[:12];password='company-fixture-only-9!';passed=[]
def sql(q,args=()):
 with db.cursor() as c:
  c.execute(q,args);return c.fetchone()[0] if c.description else None
def call(method,path,body=None,token=None,extra=None):
 h={'Content-Type':'application/json',**(extra or {})}
 if token:h['Authorization']='Bearer '+token
 try:r=urllib.request.urlopen(urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers=h),timeout=20)
 except urllib.error.HTTPError as e:r=e
 with r:
  data=r.read();return r.status,json.loads(data) if 'application/json' in r.headers.get('content-type','') else data,r.headers
def check(s):passed.append(s);print('PASS '+s,flush=True)
def account(n):
 email=f'{tag}-{n}@example.invalid';phone='010'+str(int(tag,16)+n)[-8:]
 s,otp,_=call('POST','/auth/send-otp',{'phone':phone});assert s==200
 s,row,_=call('POST','/auth/register',{'email':email,'phone':phone,'otp_code':otp['dev_code'],'password':password,'display_name':'company fixture'});assert s==200,(s,row)
 row['email']=email;return row
subject,company,other,admin=[account(n) for n in [41,42,43,44]]
uid=subject['user_id'];oid=company['user_id'];token=subject['access_token'];at=admin['access_token']
sql("UPDATE users SET role='admin' WHERE id=%s",(admin['user_id'],))
staff=sql("INSERT INTO staff(user_id,name,access_role) VALUES(%s,'PRIVATE-NAME','admin') RETURNING id",(oid,))
foreign_staff=sql("INSERT INTO staff(user_id,name) VALUES(%s,'OTHER-NAME') RETURNING id",(other['user_id'],))
sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(oid,staff,uid))
did=sql("INSERT INTO devices(device_uid,owner_id,api_key_hash,display_name) VALUES(%s,%s,'fixture','SIM-UNCHANGED') RETURNING id",(tag+'-sim',oid))
start=(datetime.now(timezone.utc)-timedelta(days=3)).replace(hour=15,minute=0,second=0,microsecond=0);end=start+timedelta(days=2);due=datetime.now(timezone.utc)+timedelta(days=7)
for t in [start-timedelta(seconds=1),start,end]:
 sql("INSERT INTO trip_annotations(user_id,device_id,driver_staff_id,trip_started_at,driver_name_snapshot) VALUES(%s,%s,%s,%s,'PRIVATE-NAME')",(oid,did,staff,t))
sql("INSERT INTO vehicle_reservations(user_id,device_id,driver_staff_id,starts_at,ends_at,status) VALUES(%s,%s,%s,%s,%s,'completed')",(oid,did,staff,start,end))
cat=sql("SELECT id FROM fleet_expense_categories WHERE owner_id=%s AND kind='expense' LIMIT 1",(oid,))
sql("INSERT INTO fleet_expenses(owner_id,created_by,request_id,request_value,spent_on,category_id,category_name,group_name,category_kind,staff_id,staff_name,department_name,vehicle_name,amount_krw,payment_method) VALUES(%s,%s,%s,'{}',%s,%s,'fixture','fixture','expense',%s,'PRIVATE-NAME','','',100,'cash')",(oid,uid,str(uuid.uuid4()),(start+timedelta(hours=9)).date(),cat,staff))
def intake(kind='access'):
 s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':kind,'scope':'Company subject fixture','password':password},token);assert s==202,(s,r);return r
def detail(r):return call('GET',f"/admin/privacy/requests/{r['id']}",token=at)[1]['request']
def cases(r):return call('GET',f"/admin/privacy/requests/{r['id']}/company-reviews",token=at)[1]
def create(r,**kw):
 b={'revision':detail(r)['revision'],'company_owner_id':oid,'staff_id':staff,'category':'trips','from_at':start.isoformat(),'until_at':end.isoformat(),'due_at':due.isoformat(),**kw}
 return call('POST',f"/admin/privacy/requests/{r['id']}/company-reviews",b,at)
def change(r,c,**kw):
 b={'request_revision':detail(r)['revision'],'revision':c['revision'],'status':'in_review','identity':'confirmed','identity_evidence':'PRIVATE-IDENTITY-REF','outcome':'','evidence_reference':'','internal_reason':'PRIVATE-REASON','public_message':'본인 자료를 검토 중입니다.','due_at':due.isoformat(),'confirmed':False,**kw}
 return call('PATCH',f"/admin/privacy/company-reviews/{c['id']}",b,at)
def finish(r,status='fulfilled'):
 return call('PATCH',f"/admin/privacy/requests/{r['id']}",{'revision':detail(r)['revision'],'status':status,'message':'Scoped review result','evidence_reference':'PRIVATE-PARENT-REF','due_at':due.isoformat()},at)
def blocked_sql(q,args=()):
 try:sql(q,args)
 except psycopg2.Error:return
 raise AssertionError('database guard missing')
r=intake()
path=f"/admin/privacy/requests/{r['id']}/company-candidates"
s,candidates,h=call('GET',path,token=at);assert s==200 and h['Cache-Control']=='no-store, private'
assert candidates['items'][0]['staff_id']==staff and candidates['items'][0]['currently_linked'] and not candidates['identity_confirmed']
assert call('GET',path,token=token)[0]==403 and call('GET',path,token=company['access_token'])[0]==403
assert call('GET',f"/privacy/requests/{r['id']}/company-reviews",token=token,extra={'X-Fleet-Owner':str(oid)})[0]==403
assert call('GET',f"/privacy/requests/{r['id']}/company-reviews",token=other['access_token'])[0]==404
check('platform-admin only, no company-admin or delegated override, private response headers')
sql('DELETE FROM fleet_staff_accounts WHERE account_id=%s',(uid,))
candidates=call('GET',path,token=at)[1];assert not candidates['items'][0]['currently_linked']
assert sql("SELECT array_agg(action ORDER BY id) FROM privacy_company_link_history WHERE subject_id=%s",(uid,))==['linked','unlinked']
assert create(r,staff_id=foreign_staff)[0]==400 and create(r,company_owner_id=uid)[0]==400
assert create(r,until_at=(start+timedelta(days=367)).isoformat())[0]==400
s,c,_=create(r);assert s==200,(s,c)
assert create(r)[0]==409
assert c['identity']=='pending' and c['status']=='identity_pending'
assert c['inventory']['trips']['count']==1 and c['inventory']['reservations']['count']==1 and c['inventory']['expenses']['count']==1,c['inventory']
assert 'PRIVATE-NAME' not in json.dumps(c['inventory'])
check('unlink retains minimal evidence; bounded owner/staff/time candidates exclude boundary records and contain no names')
s,manual,_=create(r,staff_id=None,category='files');assert s==200 and manual['identity']=='pending'
assert call('GET',f"/admin/privacy/requests/{intake('rectification')['id']}/company-candidates",token=at)[1]['items']
check('manual missing-history scope stays unverified; no automatic identity inference')
for kw in [{'status':'in_review','identity':'pending'},{'identity_evidence':''},{'status':'verified','outcome':'provided'},{'status':'verified','outcome':'erased','confirmed':True,'evidence_reference':'e'}]:
 assert change(r,c,**kw)[0]==400,kw
assert finish(r)[0]==409 and finish(r,'rejected')[0]==409
blocked_sql("UPDATE privacy_requests SET status='fulfilled' WHERE id=%s",(r['id'],))
blocked_sql("UPDATE privacy_company_reviews SET company_owner_id=%s WHERE id=%s",(other['user_id'],c['id']))
s,c,_=change(r,c,status='awaiting_company');assert s==200,(s,c)
assert finish(r)[0]==409
s,c,_=change(r,c,status='awaiting_policy');assert s==200
check('identity/evidence/outcome gates, unresolved completion refusal and database scope/completion guards')
old=detail(r)['revision'];old_case=c.copy()
s,c,_=change(r,c,status='restricted',outcome='limited',confirmed=True,evidence_reference='PRIVATE-LIMIT-REF');assert s==200
assert change(r,old_case,request_revision=old)[0]==409 and change(r,old_case)[0]==409
assert finish(r)[0]==409
s,manual,_=change(r,manual,status='excluded',identity='not_subject',outcome='not_subject',confirmed=True,evidence_reference='PRIVATE-EXCLUSION');assert s==200
s,c,_=change(r,c,status='verified',outcome='provided',confirmed=True,evidence_reference='PRIVATE-DELIVERY');assert s==200
assert len(cases(r)['events'])==7,cases(r)
s,visible,h=call('GET',f"/privacy/requests/{r['id']}/company-reviews",token=token);assert s==200 and len(visible)==2
assert set(visible[0])=={'id','category','from_at','until_at','status','message','due_at','updated_at'}
assert all(x not in json.dumps(visible) for x in ['PRIVATE','company_owner_id','staff_id','identity','inventory','actor_id'])
assert finish(r)[0]==200
assert change(r,c)[0]==409
check('revision conflicts, scoped attestation with evidence, append-only API audit and public-only projection')
# Company business data and SIM ownership remain byte-for-byte unchanged by review.
snapshot=lambda:sql("SELECT jsonb_build_object('staff',(SELECT to_jsonb(s) FROM staff s WHERE id=%s),'trips',(SELECT jsonb_agg(t ORDER BY id) FROM trip_annotations t WHERE user_id=%s),'reservations',(SELECT jsonb_agg(v ORDER BY id) FROM vehicle_reservations v WHERE user_id=%s),'expenses',(SELECT jsonb_agg(e ORDER BY id) FROM fleet_expenses e WHERE owner_id=%s),'sim_owner',(SELECT owner_id FROM devices WHERE id=%s))",(staff,oid,oid,oid,did))
before=snapshot()
closed=intake('account_closure')
sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(oid,staff,uid))
s,cc,_=create(closed,category='staff');assert s==200
assert call('POST',f"/admin/privacy/requests/{closed['id']}/close-account",{'revision':detail(closed)['revision']},at)[0]==200
assert not sql('SELECT EXISTS(SELECT 1 FROM fleet_staff_accounts WHERE account_id=%s)',(uid,))
assert sql("SELECT count(*) FROM privacy_company_link_history WHERE subject_id=%s",(uid,))==4
s,cc,_=change(closed,cc,status='awaiting_policy');assert s==200,(s,cc)
sql('DELETE FROM privacy_result_limits')
public={'email':subject['email'],'password':password,'request_id':closed['id']}
s,visible,h=call('POST','/privacy/result',public);assert s==200 and visible['account_restricted'] and len(visible['company_reviews'])==1
assert 'PRIVATE' not in json.dumps(visible) and 'company_owner_id' not in json.dumps(visible)
assert call('GET','/auth/me',token=token)[0]==401
assert snapshot()==before
check('closure preserves linkage history, review remains editable, result-only access and company/SIM records unchanged')
s,cc,_=change(closed,cc,status='verified',outcome='erased',confirmed=True,evidence_reference='SYNTHETIC-ATTESTATION');assert s==200
assert finish(closed)[0]==409
blocked_sql("UPDATE privacy_requests SET status='fulfilled' WHERE id=%s",(closed['id'],))
check('company attestation never marks whole-account erasure complete')
# Concurrent operators: exactly one stale-revision update is accepted.
rect=sql("SELECT id FROM privacy_requests WHERE user_id=%s AND kind='rectification'",(uid,));rect={'id':rect}
sql("INSERT INTO trip_annotations(user_id,device_id,driver_staff_id,trip_started_at) SELECT %s,%s,%s,%s::timestamptz+g*interval '1 second' FROM generate_series(10,10020) g",(oid,did,staff,start))
s,capped,_=create(rect,category='trips');assert s==200 and capped['inventory']['trips']=={'count':10000,'more':True}
sql("DELETE FROM trip_annotations WHERE device_id=%s AND trip_started_at>%s AND trip_started_at<%s",(did,start,end))
assert snapshot()==before
check('large candidate inventory is capped and explicitly marked incomplete without copying business rows')
s,rc,_=create(rect,category='snapshots');assert s==200
rev=detail(rect)['revision']
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
 out=list(pool.map(lambda _:change(rect,rc,request_revision=rev)[0],range(2)))
assert sorted(out)==[200,409],out
check('concurrent reviewers cannot overwrite one another')
subprocess.run(['docker','restart',API],check=True,stdout=subprocess.DEVNULL)
for _ in range(30):
 try:
  if call('POST','/privacy/result',public)[0]==200:break
 except urllib.error.URLError:pass
 time.sleep(1)
else:raise AssertionError('restart failed')
assert len(cases(closed)['events'])==3 and snapshot()==before
check('restart preserves case audit and business records')
result={'integration_groups':len(passed),'groups':passed,'api_sha256':digest,'schema':sql('SELECT max(version) FROM _sqlx_migrations')}
(pathlib.Path(__file__).parent/'company-validation.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
