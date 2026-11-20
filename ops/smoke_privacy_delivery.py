"""Authorized production check: one fresh empty synthetic account, then close it.

No real device/data/payment/message is created. Credentials are a private input,
never command arguments/output. Keep the result lookup available for UI QA until
the caller removes the private input after the check.
"""
import base64,hashlib,hmac,json,pathlib,time,urllib.request,urllib.error,uuid
import psycopg2
from privacy_file_cleanup import config
from privacy_account_closure import execute

p=pathlib.Path('/home/mmm/gps-artifacts/privacy-delivery-20261105-r1')
credential=json.loads((p/'smoke-private.json').read_text())
assert credential['email'].startswith('delivery-smoke-') and credential['email'].endswith('@example.invalid')
cfg=config('/home/mmm/projects/gps-tracker-api/.env')
with urllib.request.urlopen('https://gps.serial.kr/health') as r:health=json.load(r)
assert health['release']=='privacy-delivery-20261105-r1' and health['environment']=='production'
db=psycopg2.connect(cfg['DATABASE_URL']);db.autocommit=True
worker=psycopg2.connect(cfg['DATABASE_URL'])
def sql(query,args=()):
 with db.cursor() as q:q.execute(query,args);return q.fetchone()[0] if q.description else None
def call(method,path,body=None,token=None):
 h={'Content-Type':'application/json'}
 if token:h['Authorization']='Bearer '+token
 try:r=urllib.request.urlopen(urllib.request.Request('https://gps.serial.kr/api/v1'+path,data=None if body is None else json.dumps(body).encode(),method=method,headers=h),timeout=20)
 except urllib.error.HTTPError as e:r=e
 with r:
  raw=r.read();return r.status,json.loads(raw) if 'application/json' in r.headers.get('content-type','') else raw,r.headers
def guard():
 return sql("""SELECT md5(jsonb_build_object('account',jsonb_build_array(u.id,u.email,u.password_hash,u.role,u.display_name),
 'devices',(SELECT jsonb_agg(jsonb_build_array(d.id,d.owner_id,d.device_uid,d.iccid) ORDER BY d.id) FROM devices d WHERE d.owner_id=u.id),
 'restricted',c.restricted)::text) FROM users u JOIN privacy_account_controls c ON c.user_id=u.id WHERE u.email='user@user4.com'""")
before=guard();assert before
uid=sql("INSERT INTO users(email,password_hash,display_name,phone,phone_verified) VALUES(%s,%s,'자료 제공 운영 검증','01000000000',false) RETURNING id",(credential['email'],credential['password_hash']))
s,tokens,_=call('POST','/auth/login',{'email':credential['email'],'password':credential['password']});assert s==200,('login',s)
s,request,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'account_closure','scope':'신규 빈 시험 계정의 이용 종료 및 결과 조회 검증. 실제 장치·위치·거래 없음.','password':credential['password']},tokens['access_token']);assert s==202
rid=request['id'];lookup={'email':credential['email'],'password':credential['password'],'request_id':rid}
def result_check(restricted):
 s,row,h=call('POST','/privacy/result',lookup);assert s==200 and row['id']==rid and row['account_restricted']==restricted
 assert h['Cache-Control']=='no-store, private' and h['Pragma']=='no-cache' and h['X-Content-Type-Options']=='nosniff'
 assert set(row)=={'id','kind','status','scope','result_message','created_at','updated_at','due_at','account_restricted','history'}
 assert all(set(e)=={'status','message','created_at'} for e in row['history'])
 return row
result_check(False)
admin=sql("SELECT u.id FROM users u JOIN privacy_account_controls c ON c.user_id=u.id WHERE u.role='admin' AND NOT c.restricted ORDER BY u.id LIMIT 1");assert admin and admin!=uid
b64=lambda b:base64.urlsafe_b64encode(b).decode().rstrip('=')
now=int(time.time());message=b64(b'{"alg":"HS256","typ":"JWT"}')+'.'+b64(json.dumps({'sub':str(admin),'iat':now,'exp':now+120,'typ':'access'},separators=(',',':')).encode())
at=message+'.'+b64(hmac.new(cfg['JWT_SECRET'].encode(),message.encode(),hashlib.sha256).digest())
s,_,_=call('POST',f'/admin/privacy/requests/{rid}/close-account',{'revision':request['revision']},at);assert s==200
closed=execute(worker,rid);assert closed['personal_scope_verified'] and not closed['external_copies_verified'] and not closed['request_fulfilled']
row=result_check(True);assert row['status']=='in_review'
assert call('POST','/privacy/result',{**lookup,'password':'invalid'})[0]==401
assert call('POST','/privacy/result',{**lookup,'request_id':999999999})[0]==401
assert call('GET','/auth/me',token=tokens['access_token'])[0]==401
assert call('POST','/auth/refresh',{'refresh_token':tokens['refresh_token']})[0]==401
assert call('POST','/auth/login',{'email':credential['email'],'password':credential['password']})[0]==409
assert before==guard()
report={'release':health['release'],'synthetic_account_id':uid,'request_id':rid,'lookup_before_and_after_closure':True,'public_fields_only':True,'no_store_headers':True,'invalid_password_and_request_denied':True,'normal_login_denied':True,'old_access_and_refresh_denied':True,'user4_account_and_sim_ownership_unchanged':True,'external_messages_sent':False,'devices_created':0,'request_status':row['status'],'full_erasure_confirmed':False}
(p/'production-smoke.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
