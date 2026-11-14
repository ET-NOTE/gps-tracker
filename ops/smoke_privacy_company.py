"""Authorized GPS production smoke, two new empty synthetic accounts only.

No real SIM, location, payment, external message or company record is altered.
Private credentials are file inputs, never CLI args or printed output.
"""
import base64,hashlib,hmac,json,pathlib,time,urllib.request,urllib.error,uuid
from datetime import datetime,timedelta,timezone
import psycopg2
from privacy_file_cleanup import config
from privacy_account_closure import execute

p=pathlib.Path('/home/mmm/gps-artifacts/privacy-company-20261105-r1')
credential=json.loads((p/'smoke-private.json').read_text())
assert credential['email'].startswith('company-smoke-') and credential['email'].endswith('@example.invalid')
cfg=config('/home/mmm/projects/gps-tracker-api/.env')
with urllib.request.urlopen('https://gps.serial.kr/health') as r:health=json.load(r)
assert health['release']=='privacy-company-20261105-r1' and health['environment']=='production'
db=psycopg2.connect(cfg['DATABASE_URL']);db.autocommit=True
worker=psycopg2.connect(cfg['DATABASE_URL'])
def sql(q,args=()):
 with db.cursor() as c:
  c.execute(q,args)
  row=c.fetchone() if c.description else None
  return row[0] if row else None
def call(method,path,body=None,token=None):
 h={'Content-Type':'application/json'}
 if token:h['Authorization']='Bearer '+token
 try:r=urllib.request.urlopen(urllib.request.Request('https://gps.serial.kr/api/v1'+path,data=None if body is None else json.dumps(body).encode(),method=method,headers=h),timeout=20)
 except urllib.error.HTTPError as e:r=e
 with r:
  raw=r.read();return r.status,json.loads(raw) if 'application/json' in r.headers.get('content-type','') else raw,r.headers
def guard():
 return sql("""SELECT md5(jsonb_build_object('users',(SELECT jsonb_agg(jsonb_build_array(u.id,u.email,u.password_hash,u.role,u.display_name,c.restricted) ORDER BY u.id) FROM users u JOIN privacy_account_controls c ON c.user_id=u.id WHERE u.email IN ('user@user.com','user@user4.com')),
 'devices',(SELECT jsonb_agg(jsonb_build_array(id,owner_id,device_uid,iccid) ORDER BY id) FROM devices))::text)""")
before=guard();assert before
def mint(uid):
 b64=lambda b:base64.urlsafe_b64encode(b).decode().rstrip('=')
 now=int(time.time());message=b64(b'{"alg":"HS256","typ":"JWT"}')+'.'+b64(json.dumps({'sub':str(uid),'iat':now,'exp':now+120,'typ':'access'},separators=(',',':')).encode())
 return message+'.'+b64(hmac.new(cfg['JWT_SECRET'].encode(),message.encode(),hashlib.sha256).digest())
def account(email):
 uid=sql('SELECT id FROM users WHERE email=%s',(email,))
 if not uid:uid=sql("INSERT INTO users(email,password_hash,display_name,phone,phone_verified) VALUES(%s,%s,'회사 자료 권리 요청 운영 검증','01000000000',false) RETURNING id",(email,credential['password_hash']))
 if sql('SELECT restricted FROM privacy_account_controls WHERE user_id=%s',(uid,)):return uid,{'access_token':mint(uid)}
 s,t,_=call('POST','/auth/login',{'email':email,'password':credential['password']});assert s==200
 return uid,t
uid,tokens=account(credential['email']);oid,company=account(credential['email'].replace('@','-owner@'))
staff=sql('SELECT id FROM staff WHERE user_id=%s ORDER BY id LIMIT 1',(oid,))
if not staff:
 staff=sql("INSERT INTO staff(user_id,name) VALUES(%s,'회사 자료 검토 시험용 명단') RETURNING id",(oid,))
 sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(oid,staff,uid))
def intake(t):
 account_id=uid if t is tokens else oid
 existing=sql("SELECT to_jsonb(r) FROM privacy_requests r WHERE user_id=%s AND kind='account_closure' ORDER BY id DESC LIMIT 1",(account_id,))
 if existing:return existing
 s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'account_closure','scope':'신규 빈 시험 계정. 회사 명단 연결 및 검토 결과 조회 검증. 실제 장치·위치·거래 자료 없음.','password':credential['password']},t['access_token']);assert s==202;return r
request=intake(tokens);rid=request['id']
admin=sql("SELECT u.id FROM users u JOIN privacy_account_controls c ON c.user_id=u.id WHERE u.role='admin' AND NOT c.restricted ORDER BY u.id LIMIT 1");assert admin not in (uid,oid)
at=mint(admin)
def detail(rid):return call('GET',f'/admin/privacy/requests/{rid}',token=at)[1]['request']
s,candidates,h=call('GET',f'/admin/privacy/requests/{rid}/company-candidates',token=at);assert s==200 and candidates['items'][0]['staff_id']==staff
assert call('GET',f'/admin/privacy/requests/{rid}/company-candidates',token=tokens['access_token'])[0] in (401,403)
end=datetime.now(timezone.utc);due=end+timedelta(days=7)
c=sql('SELECT to_jsonb(c) FROM privacy_company_reviews c WHERE request_id=%s ORDER BY id LIMIT 1',(rid,))
if not c:
 s,c,_=call('POST',f'/admin/privacy/requests/{rid}/company-reviews',{'revision':request['revision'],'company_owner_id':oid,'staff_id':staff,'category':'staff','from_at':(end-timedelta(days=1)).isoformat(),'until_at':end.isoformat(),'due_at':due.isoformat()},at);assert s==200
if not sql('SELECT restricted FROM privacy_account_controls WHERE user_id=%s',(uid,)):
 s,_,_=call('POST',f'/admin/privacy/requests/{rid}/close-account',{'revision':detail(rid)['revision']},at);assert s==200
job=execute(worker,rid)
assert not job['request_fulfilled'] and 'company_membership_subject_review' in job['review_reasons']
assert sql('SELECT count(*) FROM privacy_company_link_history WHERE subject_id=%s',(uid,))==2
assert not sql('SELECT EXISTS(SELECT 1 FROM fleet_staff_accounts WHERE account_id=%s)',(uid,))
s,c,_=call('PATCH',f"/admin/privacy/company-reviews/{c['id']}",{'request_revision':detail(rid)['revision'],'revision':c['revision'],'status':'excluded','identity':'not_subject','identity_evidence':'ROUND8-SYNTHETIC-FIXTURE','outcome':'not_subject','evidence_reference':'ROUND8-NO-REAL-COMPANY-DATA','internal_reason':'운영 검증용 임시 계정·명단. 실제 정보주체의 회사 자료가 없습니다.','public_message':'시험용 명단만 있는 검증 계정으로, 실제 회사 업무 자료는 없습니다. 계정 이용 종료 후 결과 조회가 정상입니다.','due_at':due.isoformat(),'confirmed':True},at);assert s==200
lookup={'email':credential['email'],'password':credential['password'],'request_id':rid}
s,result,h=call('POST','/privacy/result',lookup);assert s==200 and result['account_restricted'] and result['status']=='in_review'
assert result['company_reviews'][0]['status']=='excluded' and h['Cache-Control']=='no-store, private'
assert all(x not in json.dumps(result) for x in ['ROUND8','identity_evidence','company_owner_id','staff_id','inventory','internal_reason'])
assert call('GET','/auth/me',token=tokens['access_token'])[0]==401
assert call('POST','/auth/login',{'email':credential['email'],'password':credential['password']})[0]==409
assert call('GET',f'/privacy/requests/{rid}/company-reviews',token=company['access_token'])[0]==404
owner_request=intake(company)
assert call('POST',f"/admin/privacy/requests/{owner_request['id']}/close-account",{'revision':owner_request['revision']},at)[0]==200
execute(worker,owner_request['id'])
assert before==guard()
report={'release':health['release'],'subject_account_id':uid,'company_account_id':oid,'staff_id':staff,'request_id':rid,'company_request_id':owner_request['id'],'candidate_and_unlink_history':True,'operator_review_after_closure':True,'requester_public_projection':True,'no_store_headers':True,'normal_login_denied':True,'real_accounts_and_sim_ownership_unchanged':True,'external_messages_sent':False,'devices_created':0,'synthetic_accounts_restricted':True,'full_erasure_confirmed':False}
(p/'production-smoke.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
