"""GPS production smoke using two newly created synthetic accounts only.
prepare: scoped grant for UI inspection; finish: revoke/close/clean synthetic data.
No real account, SIM, location, payment, email or push is changed.
"""
import base64,hashlib,hmac,json,os,pathlib,sys,time,urllib.request,urllib.error,uuid
from datetime import datetime,timedelta,timezone
import psycopg2
from privacy_file_cleanup import config
from privacy_account_closure import execute

os.umask(0o077)
p=pathlib.Path('/home/mmm/gps-artifacts/privacy-sections-20261105-r1')
private=p/'smoke-private.json';c=json.loads(private.read_text())
assert c['email'].startswith('account-smoke-') and c['email'].endswith('@example.invalid')
cfg=config('/home/mmm/projects/gps-tracker-api/.env')
with urllib.request.urlopen('https://gps.serial.kr/health') as response:health=json.load(response)
assert health['release']=='privacy-sections-20261105-r1' and health['environment']=='production'
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
if sys.argv[1]=='prepare':
 if not c.get('users'):
  assert not sql('SELECT EXISTS(SELECT 1 FROM users WHERE email=%s)',(c['email'],))
  c['baseline']=guard();c['users']=[]
  for suffix in ['', '-other']:
   email=c['email'].replace('@',suffix+'@')
   uid=sql("INSERT INTO users(email,password_hash,display_name,phone,phone_verified) VALUES(%s,%s,'개인정보 자료 검증 계정','01000000000',false) RETURNING id",(email,c['password_hash']));c['users'].append(uid)
  private.write_text(json.dumps(c))
 uid,other=c['users']
 s,login,_=call('POST','/auth/login',{'email':c['email'],'password':c['password']});assert s==200
 token=login['access_token']
 if not c.get('device_id'):
  c['device_id']=sql("INSERT INTO devices(device_uid,owner_id,api_key_hash,display_name) VALUES(%s,%s,'not-a-hardware-credential','자료 제공 검증 전용') RETURNING id",(c['email'].split('@')[0],uid));private.write_text(json.dumps(c))
 did=c['device_id']
 data=b'%PDF-1.4\nSynthetic privacy-delivery fixture. No personal information.\n%%EOF'
 if not c.get('document_id'):
  root=pathlib.Path(cfg.get('UPLOAD_DIR','/home/mmm/uploads'));folder=root/'device_documents'/str(uid)/str(did);st=root.stat()
  for part in [folder.parent.parent,folder.parent,folder]:
   if not part.exists():part.mkdir(mode=0o750);os.chown(part,st.st_uid,st.st_gid)
  path=folder/(uuid.uuid4().hex+'_fixture.pdf');path.write_bytes(data);path.chmod(0o640);os.chown(path,st.st_uid,st.st_gid);c['path']=str(path)
  c['document_id']=sql("INSERT INTO device_documents(user_id,device_id,kind,filename,stored_path,mime,size_bytes) VALUES(%s,%s,'other','개인_서류_검증용.pdf',%s,'application/pdf',%s) RETURNING id",(uid,did,str(path),len(data)));private.write_text(json.dumps(c))
 sql("UPDATE users SET prefs='{\"theme\":\"dark\",\"private_key\":\"ROUND10-PRIVATE\"}' WHERE id=%s",(uid,))
 document=c['document_id']
 if not c.get('request_id'):
  s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'access','scope':'계정 정보·요청 처리이력·검증용 개인 서류 제공 시험. 실제 정보 없음.','password':c['password']},token);assert s==202;c['request_id']=r['id'];private.write_text(json.dumps(c))
 rid=c['request_id'];r=detail(rid)
 if r['status']=='received':
  s,r,_=call('PATCH',f'/admin/privacy/requests/{rid}',{'revision':r['revision'],'status':'in_review','message':'시험용 계정·서류만 검토했습니다.','evidence_reference':'ROUND10-SYNTHETIC-ONLY','due_at':(datetime.now(timezone.utc)+timedelta(days=2)).isoformat()},at);assert s==200
 s,opts,_=call('GET',f'/admin/privacy/requests/{rid}/personal-documents',token=at);assert s==200 and [d['id'] for d in opts['items']]==[document]
 s,body,h=call('POST',f'/admin/privacy/requests/{rid}/documents/{document}/review',{},at);assert s==200 and body==data
 proof={'id':document,'sha256':h['x-document-sha256']}
 s,g,_=call('POST',f'/admin/privacy/requests/{rid}/account-packages',{'revision':r['revision'],'confirmed':True,'documents':[proof],'sections':['contact_settings','transactions','activity_metadata']},at);assert s==200,(s,g)
 c['package_id']=g['id'];private.write_text(json.dumps(c))
 endpoint=f"/privacy/account-packages/{g['id']}/account"
 assert call('POST',endpoint,{'password':c['password']},mint(other))[0]==404
 assert call('POST',endpoint,{'password':'wrong'},token)[0]==401
 s,body,h=call('POST',endpoint,{'password':c['password']},token);assert s==200 and body['account']['email']==c['email']
 assert body['format']=='gps-personal-account-v2' and body['unselected_sections']==[]
 assert body['additional']['contact_settings']['display_preferences']=={'theme':'dark'}
 assert body['additional']['transactions']['payments']==[] and body['additional']['activity_metadata']['chat_message_metadata']==[]
 assert b'ROUND10-PRIVATE' not in last_raw
 assert h['Cache-Control']=='no-store, private' and all(x not in last_raw for x in [b'password_hash',b'ROUND10-SYNTHETIC-ONLY',b'stored_path'])
 assert sql("SELECT sha256 FROM privacy_account_package_events WHERE package_id=%s AND action='account_prepared' ORDER BY id DESC LIMIT 1",(g['id'],))==hashlib.sha256(last_raw).hexdigest()
 s,body,h=call('POST',f"/privacy/account-packages/{g['id']}/documents/{document}",{'password':c['password']},token);assert s==200 and body==data
 assert guard()==c['baseline']
 print(json.dumps({'phase':'prepared','request_id':rid,'package_id':g['id'],'synthetic_accounts':c['users'],'authorization_and_document_integrity':True}))
elif sys.argv[1]=='finish':
 uid,other=c['users'];rid=c['request_id'];pid=c['package_id']
 assert call('POST',f'/admin/privacy/account-packages/{pid}/revoke',{},at)[0]==200
 assert call('POST',f'/privacy/account-packages/{pid}/account',{'password':c['password']},mint(uid))[0]==410
 if detail(rid)['status']!='cancelled':
  s,_,_=call('POST',f'/privacy/requests/{rid}/cancel',{'revision':detail(rid)['revision']},mint(uid));assert s==200
 for subject in c['users']:
  if sql('SELECT restricted FROM privacy_account_controls WHERE user_id=%s',(subject,)):continue
  s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'account_closure','scope':'라운드10 시험 계정 이용 종료. 검증용 파일 외 실제 자료 없음.','password':c['password']},mint(subject));assert s==202
  assert call('POST',f"/admin/privacy/requests/{r['id']}/close-account",{'revision':r['revision']},at)[0]==200
  job=execute(worker,r['id']);assert not job['request_fulfilled']
 assert call('POST',f'/privacy/account-packages/{pid}/account',{'password':c['password']},mint(uid))[0]==401
 cleanup=sql("SELECT id FROM privacy_file_cleanup WHERE storage_key=%s",(c['path'],));assert cleanup
 for _ in range(31):
  if not pathlib.Path(c['path']).exists():break
  time.sleep(5)
 assert not pathlib.Path(c['path']).exists(),'scheduled cleanup pending'
 assert not sql('SELECT EXISTS(SELECT 1 FROM device_documents WHERE id=%s)',(c['document_id'],))
 assert sql('SELECT device_uid FROM devices WHERE id=%s',(c['device_id'],))==c['email'].split('@')[0]
 sql('DELETE FROM devices WHERE id=%s',(c['device_id'],))
 assert guard()==c['baseline']
 report={'release':health['release'],'schema':sql('SELECT max(version) FROM _sqlx_migrations'),'request_id':rid,'package_id':pid,'synthetic_account_ids':c['users'],'owner_password_scope_checked':True,'account_whitelist_and_audit_checked':True,'reviewed_document_integrity_checked':True,'revoked_then_account_closed':True,'synthetic_file_removed':True,'synthetic_device_removed':True,'real_accounts_and_sim_ownership_unchanged':True,'external_messages_sent':False,'full_erasure_confirmed':False,'explicit_sections_verified':True,'real_payments_or_messages':False}
 (p/'production-smoke.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
else:raise ValueError('prepare or finish')
