"""GPS-only production smoke with three fresh synthetic accounts.
Closes accounts and revokes access; retains the small synthetic evidence/audit for review.
No real account, SIM, location, payment, email or push is changed.
"""
import base64,hashlib,hmac,json,os,pathlib,sys,time,urllib.request,urllib.error,uuid
from datetime import datetime,timedelta,timezone
import psycopg2
from privacy_file_cleanup import config
from privacy_account_closure import execute

os.umask(0o077)
p=pathlib.Path('/home/mmm/gps-artifacts/privacy-company-tasks-20261105-r1')
private=p/'smoke-private.json';c=json.loads(private.read_text())
assert c['email'].startswith('account-smoke-') and c['email'].endswith('@example.invalid')
cfg=config('/home/mmm/projects/gps-tracker-api/.env')
with urllib.request.urlopen('https://gps.serial.kr/health') as response:health=json.load(response)
assert health['release']=='privacy-company-tasks-20261105-r1' and health['environment']=='production'
db=psycopg2.connect(cfg['DATABASE_URL']);db.autocommit=True
worker=psycopg2.connect(cfg['DATABASE_URL'])
def sql(q,args=()):
 with db.cursor() as cur:
  cur.execute(q,args);row=cur.fetchone() if cur.description else None;return row[0] if row else None
def call(method,path,body=None,token=None):
 global last_raw
 headers={'Content-Type':'application/json'}
 if token:headers['Authorization']='Bearer '+token
 try:r=urllib.request.urlopen(urllib.request.Request('https://gps.serial.kr/api/v1'+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers=headers),timeout=20)
 except urllib.error.HTTPError as e:r=e
 with r:
  last_raw=r.read();return r.status,json.loads(last_raw) if 'application/json' in r.headers.get('content-type','') else last_raw,r.headers
def mint(uid):
 b64=lambda b:base64.urlsafe_b64encode(b).decode().rstrip('=')
 now=int(time.time());msg=b64(b'{"alg":"HS256","typ":"JWT"}')+'.'+b64(json.dumps({'sub':str(uid),'iat':now,'exp':now+120,'typ':'access'},separators=(',',':')).encode())
 return msg+'.'+b64(hmac.new(cfg['JWT_SECRET'].encode(),msg.encode(),hashlib.sha256).digest())
def guard():
 return sql("""SELECT md5(jsonb_build_object('users',(SELECT jsonb_agg(jsonb_build_array(u.id,u.email,u.password_hash,u.role,u.display_name,c.restricted) ORDER BY u.id) FROM users u JOIN privacy_account_controls c ON c.user_id=u.id WHERE u.email IN ('user@user.com','user@user4.com')),'devices',(SELECT jsonb_agg(jsonb_build_array(id,owner_id,device_uid,iccid) ORDER BY id) FROM devices WHERE device_uid NOT LIKE 'account-smoke-%%'))::text)""")
admin=sql("SELECT u.id FROM users u JOIN privacy_account_controls c ON c.user_id=u.id WHERE u.role='admin' AND NOT c.restricted ORDER BY u.id LIMIT 1");assert admin
at=mint(admin)
def detail(rid):return call('GET',f'/admin/privacy/requests/{rid}',token=at)[1]['request']

assert not c.get('users'), 'run once; inspect private checkpoint before any retry'
c['baseline']=guard();c['users']=[]
for suffix in ['', '-company', '-other']:
 email=c['email'].replace('@',suffix+'@')
 uid=sql("INSERT INTO users(email,password_hash,display_name,phone,phone_verified) VALUES(%s,%s,'회사 증빙 기능 검증용','01000000000',false) RETURNING id",(email,c['password_hash']));c['users'].append(uid);private.write_text(json.dumps(c))
uid,oid,other=c['users']
s,login,_=call('POST','/auth/login',{'email':c['email'],'password':c['password']});assert s==200;token=login['access_token']
s,login,_=call('POST','/auth/login',{'email':c['email'].replace('@','-company@'),'password':c['password']});assert s==200;ct=login['access_token']
staff=sql("INSERT INTO staff(user_id,name,access_role) VALUES(%s,'모의 명단 - 실제 직원 아님','member') RETURNING id",(oid,));c['staff_id']=staff;private.write_text(json.dumps(c))
s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'access','scope':'합성 명단과 증빙만 사용하는 회사 처리 보고 검증','password':c['password']},token);assert s==202
rid=r['id'];c['request_id']=rid;private.write_text(json.dumps(c))
now=datetime.now(timezone.utc);due=now+timedelta(days=1)
s,review,_=call('POST',f'/admin/privacy/requests/{rid}/company-reviews',{'revision':r['revision'],'company_owner_id':oid,'staff_id':staff,'category':'staff','from_at':(now-timedelta(days=1)).isoformat(),'until_at':now.isoformat(),'due_at':due.isoformat()},at);assert s==200,(s,review)
c['review_id']=review['id'];private.write_text(json.dumps(c))
s,review,_=call('PATCH',f"/admin/privacy/company-reviews/{review['id']}",{'request_revision':detail(rid)['revision'],'revision':review['revision'],'status':'awaiting_company','identity':'confirmed','identity_evidence':'SYNTHETIC-ROUND11','outcome':'','evidence_reference':'','internal_reason':'모의 명단 확인','public_message':'검증용 회사 자료 범위입니다.','due_at':due.isoformat(),'confirmed':False},at);assert s==200
s,task,_=call('POST',f"/admin/privacy/company-reviews/{review['id']}/tasks",{'request_revision':detail(rid)['revision'],'review_revision':review['revision'],'instructions':'실제 개인정보 없는 합성 증빙 검증입니다.','expires_at':due.isoformat(),'confirmed':True},at);assert s==200,(s,task)
tid=task['id'];c['task_id']=tid;private.write_text(json.dumps(c));path=f'/privacy/company-tasks/{tid}'
s,t,h=call('GET',path,token=ct);assert s==200 and h['Cache-Control']=='no-store, private'
assert 'SYNTHETIC-ROUND11' not in json.dumps(t) and 'identity_evidence' not in json.dumps(t)
assert call('GET',path,token=token)[0]==404 and call('GET',path,token=mint(other))[0]==404
proof=(p/'synthetic-proof.pdf').read_bytes();assert len(proof)<2000 and proof.startswith(b'%PDF-')
s,pf,_=call('POST',path,{'revision':t['task']['revision'],'outcome':'provided','executed_at':now.isoformat(),'affected_count':1,'summary':'합성 자료 전달 결과를 시험합니다. 실제 개인정보 없음.','evidence_reference':'ROUND11-TEST-RECEIPT','filename':'synthetic-proof.pdf','mime':'application/pdf','file_base64':base64.b64encode(proof).decode(),'confirmed':True},ct);assert s==200,(s,pf)
sid=pf['id'];c['submission_id']=sid;private.write_text(json.dumps(c))
def latest():return call('GET',f"/admin/privacy/company-reviews/{review['id']}/tasks",token=at)[1]['items'][0]
v=latest();assert v['task']['status']=='submitted'
reviews=call('GET',f'/admin/privacy/requests/{rid}/company-reviews',token=at)[1]['items'];rv=next(x for x in reviews if x['id']==review['id'])
decision={'request_revision':detail(rid)['revision'],'review_revision':rv['revision'],'revision':v['task']['revision'],'submission_id':sid,'sha256':pf['sha256'],'accept':True,'confirmed':True,'feedback':'합성 증빙 원문과 전송 해시 확인','public_message':'합성 자료 전달 결과 검증을 마쳤습니다.'}
assert call('POST',f'/admin/privacy/company-tasks/{tid}/decision',decision,at)[0]==409
s,data,h=call('POST',f'/admin/privacy/company-tasks/{tid}/proof/{sid}',token=at);assert s==200 and data==proof and h['X-Content-Type-Options']=='nosniff'
assert pf['sha256']==hashlib.sha256(data).hexdigest()
assert call('POST',f'/admin/privacy/company-tasks/{tid}/decision',decision,at)[0]==200
assert latest()['task']['status']=='accepted' and detail(rid)['status']!='fulfilled'
public=call('GET',f'/privacy/requests/{rid}/company-reviews',token=token)[1]
assert public[0]['status']=='verified' and all(x not in json.dumps(public) for x in ['ROUND11-TEST','synthetic-proof','company_owner_id','staff_id'])
assert guard()==c['baseline']
assert call('POST',f'/admin/privacy/company-tasks/{tid}/revoke',{'request_revision':detail(rid)['revision'],'revision':latest()['task']['revision'],'reason':'모의 검증 종료'},at)[0]==200
assert call('GET',path,token=ct)[0]==409
assert call('POST',f'/privacy/requests/{rid}/cancel',{'revision':detail(rid)['revision']},token)[0]==200
closures=[]
for subject in c['users']:
 s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'account_closure','scope':'라운드11 모의 검증 계정 이용 종료','password':c['password']},mint(subject));assert s==202
 assert call('POST',f"/admin/privacy/requests/{r['id']}/close-account",{'revision':r['revision']},at)[0]==200
 job=execute(worker,r['id']);assert not job['request_fulfilled'];closures.append(job)
assert all(sql('SELECT restricted FROM privacy_account_controls WHERE user_id=%s',(u,)) for u in c['users'])
assert all('company_evidence_retention_review' in j['review_reasons'] for j in closures[:2])
assert guard()==c['baseline']
report={'release':health['release'],'schema':sql('SELECT max(version) FROM _sqlx_migrations'),'request_id':rid,'review_id':review['id'],'task_id':tid,'submission_id':sid,'synthetic_account_ids':c['users'],'company_scope_and_foreign_account_denial':True,'review_before_acceptance':True,'proof_hash_and_download_integrity':True,'no_automatic_whole_request_completion':True,'public_projection_excludes_internal_evidence':True,'revoked_and_accounts_closed':True,'retained_synthetic_proof_bytes':len(proof),'company_evidence_retention_review':True,'real_accounts_and_sim_ownership_unchanged':True,'external_messages_sent':False,'full_erasure_confirmed':False}
(p/'production-smoke.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
