"""No production mode: real API/DB workflow in an internal Docker network only."""
import base64,concurrent.futures,csv,hashlib,io,json,pathlib,subprocess,time,urllib.error,urllib.request,uuid
from datetime import datetime,timedelta,timezone
import psycopg as psycopg2

NETWORK='gps-provision22-test-20261111cumulative111';DB='gps-provision22-db-20261111cumulative111';API='gps-provision22-api-20261111cumulative111'
inspect=lambda kind,name:json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NETWORK)['Internal']
di,ai=inspect('container',DB),inspect('container',API)
cfg=dict(v.split('=',1) for v in ai['Config']['Env'] if '=' in v)
assert cfg['APP_ENV']=='test' and urllib.parse.urlparse(cfg['DATABASE_URL']).username=='gps_runtime' and urllib.parse.urlparse(cfg['DATABASE_URL']).hostname in ('closure-db',di['NetworkSettings']['Networks'][NETWORK]['IPAddress']) and urllib.parse.urlparse(cfg['DATABASE_URL']).path=='/gps_closure_test'
binary=pathlib.Path(__file__).parent/'out/gps-tracker-api';digest=hashlib.sha256(binary.read_bytes()).hexdigest()
assert subprocess.check_output(['docker','exec',API,'sha256sum','/proc/1/exe']).decode().split()[0]==digest
base=f"http://{ai['NetworkSettings']['Networks'][NETWORK]['IPAddress']}:3043/gps-tracker/api/v1"
db=psycopg2.connect(f"postgres://postgres:closure-test-only@{di['NetworkSettings']['Networks'][NETWORK]['IPAddress']}/gps_closure_test");db.autocommit=True;db.execute("SELECT set_config('gps.storage_keys',%s,false)",(pathlib.Path(__file__).with_name('test-keys.json').read_text(),))
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

r=intake();s,c,_=create(r);assert s==200
ct=company['access_token'];ot=other['access_token']
def fresh():return next(x for x in cases(r)['items'] if x['id']==c['id'])
def tasks():return call('GET',f"/admin/privacy/company-reviews/{c['id']}/tasks",token=at)[1]
def item():return tasks()['items'][0]
def pub(**kw):
 return call('POST',f"/admin/privacy/company-reviews/{c['id']}/tasks",{'request_revision':detail(r)['revision'],'review_revision':fresh()['revision'],'instructions':'Only this staff and period. No private identity.','expires_at':due.isoformat(),'confirmed':True,**kw},at)
assert pub()[0]==409
s,c,_=change(r,c);assert s==200
assert pub(confirmed=False)[0]==400
assert pub(expires_at=(datetime.now(timezone.utc)+timedelta(days=15)).isoformat())[0]==400
assert pub(review_revision=0)[0]==409
s,t,_=pub();assert s==200,(s,t);tid=t['id'];path=f'/privacy/company-tasks/{tid}'
assert pub()[0]==409
assert call('POST',f"/admin/privacy/company-reviews/{c['id']}/tasks",{},ct)[0] in (403,422)
check('publication requires platform admin, identity, bounded scope, explicit disclosure and matching revisions')
s,inbox,h=call('GET','/privacy/company-tasks',token=ct);assert s==200 and h['Cache-Control']=='no-store, private'
assert inbox['items'][0]['staff_id']==staff
serialized=json.dumps(inbox)
assert all(x not in serialized for x in ['PRIVATE','user_id','request_id','identity_evidence','inventory','internal_reason'])
assert call('GET',path,token=ot)[0]==404 and call('GET',path,token=token)[0]==404
assert call('GET','/privacy/company-tasks',token=token,extra={'X-Fleet-Owner':str(oid)})[0]==403
assert call('GET','/privacy/company-tasks',token=ot)[1]['items']==[]
check('only company owner gets allowlisted task projection; requester, foreign owner and delegated scope cannot access')
proof=b'%PDF-1.4\n% synthetic processing evidence only\n%%EOF'
def body(**kw):return {'revision':item()['task']['revision'],'outcome':'provided','executed_at':datetime.now(timezone.utc).isoformat(),'affected_count':1,'summary':'Synthetic transfer confirmed against local receipt.','evidence_reference':'TEST-RECEIPT','filename':'processing.pdf','mime':'application/pdf','file_base64':base64.b64encode(proof).decode(),'confirmed':True,**kw}
for kw in [{'confirmed':False},{'file_base64':'!!'},{'mime':'text/html'},{'file_base64':base64.b64encode(b'html').decode()},{'filename':'../x.pdf'},{'outcome':'erased'},{'executed_at':(due).isoformat()},{'affected_count':-1},{'summary':''}]:
 assert call('POST',path,body(**kw),ct)[0]==400,kw
assert call('POST',path,body(file_base64=base64.b64encode(b'%PDF-'+b'x'*(2*1024*1024)).decode()),ct)[0]==400
assert call('POST',path,body(),ot)[0]==404
check('file types, signature, size, path, timestamp, result, attestation and report validation')
b=body();before_assignee=detail(r)['assigned_to']
with concurrent.futures.ThreadPoolExecutor(2) as pool:out=list(pool.map(lambda _:call('POST',path,b,ct)[0],[0,1]))
assert sorted(out)==[200,409],out
cur=item();sid=cur['submissions'][0]['id'];assert cur['task']['status']=='submitted' and fresh()['status']=='awaiting_company'
assert detail(r)['assigned_to']==before_assignee
assert finish(r)[0]==409
assert change(r,fresh(),status='verified',outcome='provided',confirmed=True,evidence_reference='BYPASS')[0]==409
blocked_sql("UPDATE privacy_company_reviews SET status='verified',outcome='provided',evidence_reference='BYPASS',internal_reason='x' WHERE id=%s",(c['id'],))
blocked_sql('UPDATE privacy_company_submissions SET summary=summary WHERE id=%s',(sid,))
blocked_sql('DELETE FROM privacy_company_submissions WHERE id=%s',(sid,))
check('concurrent submission is single immutable report, no assigned-admin replacement or completion bypass')
def decide(accept=True,**kw):
 v=item();p=v['submissions'][0]
 b={'request_revision':detail(r)['revision'],'review_revision':fresh()['revision'],'revision':v['task']['revision'],'submission_id':p['id'],'sha256':p['sha256'],'accept':accept,'confirmed':True,'feedback':'Checked processing evidence; scoped result only.','public_message':'지정 범위 처리 결과를 확인했습니다.',**kw}
 return call('POST',f'/admin/privacy/company-tasks/{tid}/decision',b,at)
assert decide()[0]==409
s,data,h=call('POST',path+f'/proof/{sid}',token=ct);assert s==200 and data==proof and h['X-Content-Type-Options']=='nosniff'
assert decide()[0]==409
assert call('POST',f'/admin/privacy/company-tasks/{tid}/proof/{sid}',token=ct)[0]==403
s,data,h=call('POST',f'/admin/privacy/company-tasks/{tid}/proof/{sid}',token=at);assert s==200 and data==proof and h['Content-Type']=='application/octet-stream'
assert decide(sha256='0'*64)[0]==409 and decide(confirmed=False)[0]==400
assert decide(False)[0]==200
assert item()['task']['status']=='changes_requested'
check('only reviewing admin proof response enables attested decision; owner download and wrong hash do not')
assert call('POST',path,body(summary='Corrected evidence attached.'),ct)[0]==200
cur=item();sid2=cur['submissions'][0]['id'];assert sid2!=sid and len(cur['submissions'])==2
assert decide()[0]==409 and decide(submission_id=sid)[0]==409
call('POST',f'/admin/privacy/company-tasks/{tid}/proof/{sid2}',token=at)
assert decide()[0]==200
assert fresh()['status']=='verified' and fresh()['evidence_reference']==f'company-task:{tid}/submission:{sid2}'
assert detail(r)['status']!='fulfilled'
assert sql('SELECT count(*) FROM trip_annotations WHERE user_id=%s',(oid,))==3
assert sql('SELECT owner_id FROM gps_read_devices WHERE id=%s',(did,))==oid
public=call('GET',f"/privacy/requests/{r['id']}/company-reviews",token=token)[1]
assert 'TEST-RECEIPT' not in json.dumps(public) and 'processing.pdf' not in json.dumps(public)
check('new revision needs new proof review; acceptance links exact report without source, SIM or whole-request mutation')
def revoke():return call('POST',f'/admin/privacy/company-tasks/{tid}/revoke',{'request_revision':detail(r)['revision'],'revision':item()['task']['revision'],'reason':'Re-scope fixture'},at)
assert revoke()[0]==200 and fresh()['status']=='awaiting_company'
assert call('GET',path,token=ct)[0]==409 and call('POST',path+f'/proof/{sid}',token=ct)[0]==409
assert call('POST',f'/admin/privacy/company-tasks/{tid}/proof/{sid}',token=at)[0]==200
assert len(item()['submissions'])==2
check('revocation removes company access and completion state, retaining administrator evidence history')
s,t,_=pub(expires_at=(datetime.now(timezone.utc)+timedelta(seconds=2)).isoformat());assert s==200;tid=t['id'];path=f'/privacy/company-tasks/{tid}'
assert call('POST',path,body(),ct)[0]==200
time.sleep(2.1)
assert call('GET',path,token=ct)[0]==409 and decide()[0]==409
assert call('GET','/privacy/company-tasks',token=ct)[1]['items']==[]
assert revoke()[0]==200
check('expired task cannot be viewed, submitted or accepted; administrator can revoke and preserve history')
s,t,_=pub();assert s==200;tid=t['id'];path=f'/privacy/company-tasks/{tid}'
assert call('POST',path,body(),ct)[0]==200
sid=item()['submissions'][0]['id']
s,_,_=call('POST',f"/privacy/requests/{r['id']}/cancel",{'revision':detail(r)['revision']},token);assert s==200
assert call('GET',path,token=ct)[0]==409 and decide()[0]==409
assert call('POST',f'/admin/privacy/company-tasks/{tid}/proof/{sid}',token=at)[0]==200
check('cancelled parent removes company access and decisions while retaining administrator audit')
s,closure,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'account_closure','scope':'Synthetic company closure','password':password},ct);assert s==202
s,closed,_=call('POST',f"/admin/privacy/requests/{closure['id']}/close-account",{'revision':closure['revision']},at);assert s==200,(s,closed)
assert call('GET','/privacy/company-tasks',token=ct)[0] in (401,403)
from privacy_account_closure import process
report=process(db,closure['id'],execute=True)
assert report['retained_review_counts']['privacy_company_submissions']==4
assert 'company_evidence_retention_review' in report['review_reasons'] and not report['personal_scope_verified']
check('closed company cannot access reports; evidence is explicitly counted as a retention review, not anonymous or deleted')
result={'integration_groups':len(passed),'groups':passed,'api_sha256':digest}
(pathlib.Path(__file__).parent/'company-tasks-validation.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
