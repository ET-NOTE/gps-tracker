"""GPS-only production smoke with two fresh synthetic accounts.
Closes accounts and revokes access; retains only delivery selection/audit metadata for retention review.
No real account, SIM, location, payment, email or push is changed.
"""
import base64,hashlib,hmac,json,os,pathlib,sys,time,urllib.request,urllib.error,uuid
from datetime import datetime,timedelta,timezone
import psycopg2
from privacy_file_cleanup import config
from privacy_account_closure import execute

os.umask(0o077)
p=pathlib.Path('/home/mmm/gps-artifacts/privacy-redacted-20261105-r1')
private=p/'smoke-private.json';c=json.loads(private.read_text())
assert c['email'].startswith('account-smoke-') and c['email'].endswith('@example.invalid')
cfg=config('/home/mmm/projects/gps-tracker-api/.env')
with urllib.request.urlopen('https://gps.serial.kr/health') as response:health=json.load(response)
assert health['release']=='privacy-redacted-20261105-r1' and health['environment']=='production'
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
 now=int(time.time());msg=b64(b'{"alg":"HS256","typ":"JWT"}')+'.'+b64(json.dumps({'sub':str(uid),'iat':now,'exp':now+600,'typ':'access'},separators=(',',':')).encode())
 return msg+'.'+b64(hmac.new(cfg['JWT_SECRET'].encode(),msg.encode(),hashlib.sha256).digest())
def guard():
 return sql("""SELECT md5(jsonb_build_object('users',(SELECT jsonb_agg(jsonb_build_array(u.id,u.email,u.password_hash,u.role,u.display_name,c.restricted) ORDER BY u.id) FROM users u JOIN privacy_account_controls c ON c.user_id=u.id WHERE u.email IN ('user@user.com','user@user4.com')),'devices',(SELECT jsonb_agg(jsonb_build_array(id,owner_id,device_uid,iccid) ORDER BY id) FROM devices WHERE device_uid NOT LIKE 'account-smoke-%%'))::text)""")
admin=sql("SELECT u.id FROM users u JOIN privacy_account_controls c ON c.user_id=u.id WHERE u.role='admin' AND NOT c.restricted ORDER BY u.id LIMIT 1");assert admin
at=mint(admin)
def detail(rid):return call('GET',f'/admin/privacy/requests/{rid}',token=at)[1]['request']

assert not c.get('users'), 'run once; inspect private checkpoint before retry'
c['baseline']=guard();c['users']=[]
for suffix in ['', '-other']:
 email=c['email'].replace('@',suffix+'@')
 uid=sql("INSERT INTO users(email,password_hash,display_name,phone,phone_verified) VALUES(%s,%s,'본문 부분 제공 모의 검증','01000000000',false) RETURNING id",(email,c['password_hash']));c['users'].append(uid);private.write_text(json.dumps(c))
uid,other=c['users']
s,login,_=call('POST','/auth/login',{'email':c['email'],'password':c['password']});assert s==200;token=login['access_token']
thread=sql('INSERT INTO chat_threads(user_id) VALUES(%s) RETURNING id',(uid,))
original='본인😀 요청\n다른 사람 SYNTHETIC-PRIVATE\n끝'
sid=sql("INSERT INTO chat_messages(thread_id,sender_role,body) VALUES(%s,'user',%s) RETURNING id",(thread,original));c['source_id']=sid;private.write_text(json.dumps(c))
s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'access','scope':'합성 채팅 본문을 일부 제공하는 기능 검증','password':c['password']},token);assert s==202;rid=r['id'];c['request_id']=rid;private.write_text(json.dumps(c))
due=(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()
s,r,_=call('PATCH',f'/admin/privacy/requests/{rid}',{'revision':r['revision'],'status':'in_review','message':'합성 자료의 범위를 검토합니다.','evidence_reference':'ROUND12-SYNTHETIC','due_at':due},at);assert s==200
path=f'/admin/privacy/requests/{rid}'
assert call('GET',path+'/text-sources?kind=chat',token=token)[0]==403
s,src,h=call('POST',path+f'/text-sources/chat/{sid}',{},at);assert s==200 and src['body']==original
assert h['Cache-Control']=='no-store, private'
b={'source_kind':'chat','source_id':sid,'source_sha256':src['source_sha256'],'ranges':[{'start':0,'end':7},{'start':len(original)-1,'end':len(original)}],'notice':'모의 본인 요청만 포함하고 제3자 정보는 제외했습니다.'}
assert call('POST',path+'/redacted',{'revision':detail(rid)['revision'],'confirmed':True,'preview_sha256':'0'*64,**b},at)[0]==409
s,preview,h=call('POST',path+'/redacted-preview',b,at);assert s==200 and 'SYNTHETIC-PRIVATE' not in json.dumps(preview)
s,result,_=call('POST',path+'/redacted',{'revision':detail(rid)['revision'],'confirmed':True,'preview_sha256':preview['preview_sha256'],**b},at);assert s==200,(s,result)
pid=result['id'];c['delivery_id']=pid;private.write_text(json.dumps(c))
assert detail(rid)['status']=='in_review'
public=call('GET',f'/privacy/requests/{rid}/redacted',token=token)[1]
assert len(public['items'])==1 and all(x not in json.dumps(public) for x in ['source_sha256','ranges','SYNTHETIC-PRIVATE','source_id'])
assert call('POST',f'/privacy/redacted/{pid}/download',{'password':c['password']},mint(other))[0]==404
assert call('POST',f'/privacy/redacted/{pid}/download',{'password':'wrong'},token)[0]==401
s,data,h=call('POST',f'/privacy/redacted/{pid}/download',{'password':c['password']},token);assert s==200
parsed=json.loads(data);assert parsed['text']==preview['text'] and 'SYNTHETIC-PRIVATE' not in data.decode()
assert h['Content-Type']=='application/octet-stream' and h['X-Content-Type-Options']=='nosniff' and 'attachment' in h['Content-Disposition']
assert sql('SELECT body FROM chat_messages WHERE id=%s',(sid,))==original
assert guard()==c['baseline']
assert call('POST',f'/admin/privacy/redacted/{pid}/revoke',{},at)[0]==200
assert call('POST',f'/privacy/redacted/{pid}/download',{'password':c['password']},token)[0]==410
assert call('POST',f'/privacy/requests/{rid}/cancel',{'revision':detail(rid)['revision']},token)[0]==200
# Remove only our exact synthetic source; immutable selection/audit metadata stays.
assert sql('SELECT email FROM users WHERE id=%s',(uid,))==c['email']
assert sql('SELECT user_id FROM chat_threads WHERE id=%s',(thread,))==uid
sql('DELETE FROM chat_messages WHERE id=%s AND thread_id=%s',(sid,thread))
sql('DELETE FROM chat_threads WHERE id=%s AND user_id=%s',(thread,uid))
for subject in c['users']:
 s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'account_closure','scope':'라운드12 모의 검증 계정 이용 종료','password':c['password']},mint(subject));assert s==202
 assert call('POST',f"/admin/privacy/requests/{r['id']}/close-account",{'revision':r['revision']},at)[0]==200
 result=execute(worker,r['id']);assert not result['request_fulfilled']
assert all(sql('SELECT restricted FROM privacy_account_controls WHERE user_id=%s',(u,)) for u in c['users'])
assert guard()==c['baseline']
report={'release':health['release'],'schema':sql('SELECT max(version) FROM _sqlx_migrations'),'request_id':rid,'delivery_id':pid,'synthetic_account_ids':c['users'],'preview_gate':True,'password_and_foreign_account_denial':True,'redacted_content_only':True,'raw_source_unchanged_by_delivery':True,'revocation_enforced':True,'no_automatic_whole_request_completion':True,'synthetic_source_removed_and_accounts_closed':True,'real_accounts_and_sim_ownership_unchanged':True,'external_messages_sent':False,'full_erasure_confirmed':False}
(p/'production-smoke.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
