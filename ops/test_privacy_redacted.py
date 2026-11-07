"""No production mode: real API/DB workflow in an internal Docker network only."""
import base64,concurrent.futures,csv,hashlib,io,json,pathlib,subprocess,time,urllib.error,urllib.request,uuid
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
tag=uuid.uuid4().hex[:12];password='redaction-fixture-only-9!';passed=[]
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
ct=company['access_token'];ot=other['access_token']
text='본인😀 자료\n타인 SECRET-OTHER\n끝'
thread=sql('INSERT INTO chat_threads(user_id) VALUES(%s) RETURNING id',(uid,))
sid=sql("INSERT INTO chat_messages(thread_id,sender_role,body,meta) VALUES(%s,'user',%s,'{\"secret\":\"META-SECRET\"}') RETURNING id",(thread,text))
foreign_thread=sql('INSERT INTO chat_threads(user_id) VALUES(%s) RETURNING id',(other['user_id'],))
foreign=sql("INSERT INTO chat_messages(thread_id,sender_role,body) VALUES(%s,'user','FOREIGN-SECRET') RETURNING id",(foreign_thread,))
did=sql("INSERT INTO devices(device_uid,owner_id,api_key_hash) VALUES(%s,%s,'fixture') RETURNING id",(tag+'-sim',uid))
aid=sql("INSERT INTO ai_analyses(user_id,device_id,target_date,analysis) VALUES(%s,%s,CURRENT_DATE,%s) RETURNING id",(uid,did,text))
due=(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()
def intake():
 s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'access','scope':'Scoped text review fixture','password':password},token);assert s==202
 s,r,_=call('PATCH',f"/admin/privacy/requests/{r['id']}",{'revision':r['revision'],'status':'in_review','message':'Identity and scope review','evidence_reference':'TEST-IDENTITY','due_at':due},at);assert s==200;return r
r=intake();rid=r['id'];basepath=f'/admin/privacy/requests/{rid}'
def revision():return call('GET',f'/admin/privacy/requests/{rid}',token=at)[1]['request']['revision']
def select(kind='chat',id=sid):return {'source_kind':kind,'source_id':id,'source_sha256':hashlib.sha256(text.encode()).hexdigest(),'ranges':[{'start':0,'end':7},{'start':len(text)-1,'end':len(text)}],'notice':'Only own material; third-party content excluded.'}
def review(kind='chat',id=sid):return call('POST',basepath+f'/text-sources/{kind}/{id}',{},at)
def preview(b):return call('POST',basepath+'/redacted-preview',b,at)
def issue(b,**kw):
 s,p,_=preview(b);assert s==200,(s,p)
 return call('POST',basepath+'/redacted',{'revision':revision(),'confirmed':True,'preview_sha256':p['preview_sha256'],**b,**kw},at)
def download(id,who=token,pwd=password):return call('POST',f'/privacy/redacted/{id}/download',{'password':pwd},who)
s,items,h=call('GET',basepath+'/text-sources?kind=chat',token=at);assert s==200 and len(items['items'])==1 and h['Cache-Control']=='no-store, private'
assert 'body' not in json.dumps(items) and 'SECRET' not in json.dumps(items)
assert call('GET',basepath+'/text-sources?kind=chat',token=token)[0]==403
assert review(id=foreign)[0]==409 and review(kind='company')[0]==400
assert preview(select())[0]==409
s,src,h=review();assert s==200 and src['body']==text and 'META-SECRET' not in json.dumps(src)
assert h['X-Content-Type-Options']=='nosniff'
check('source options omit bodies; admin review is account-scoped and required before preview')
for ranges in [[],[{'start':-1,'end':1}],[{'start':0,'end':999}],[{'start':1,'end':1}],[{'start':2,'end':4},{'start':1,'end':2}],[{'start':0,'end':3},{'start':2,'end':4}]]:
 assert preview({**select(),'ranges':ranges})[0] in (400,422)
for overrides in [{'notice':''},{'source_sha256':'0'*64},{'source_kind':'receipt'}]:assert preview({**select(),**overrides})[0] in (400,409)
s,p,_=preview(select());assert s==200 and p['text']=='본인😀 자료\n[비공개]끝' and 'SECRET' not in json.dumps(p)
assert issue(select(),confirmed=False)[0]==400
assert issue(select(),revision=0)[0]==409
b={**select(),'notice':'Changed after preview'}
assert call('POST',basepath+'/redacted',{'revision':revision(),'confirmed':True,'preview_sha256':p['preview_sha256'],**b},at)[0]==409
sql("UPDATE users SET role='admin' WHERE id=%s",(company['user_id'],))
assert call('POST',basepath+'/redacted-preview',select(),ct)[0]==409
check('Unicode selection, gaps, bounds and exact preview/attestation/revision binding')
s,p,_=preview(select());b={'revision':revision(),'confirmed':True,'preview_sha256':p['preview_sha256'],**select()}
with concurrent.futures.ThreadPoolExecutor(2) as pool:out=list(pool.map(lambda _:call('POST',basepath+'/redacted',b,at),[0,1]))
assert sorted(x[0] for x in out)==[200,409];pid=next(x[1]['id'] for x in out if x[0]==200)
assert call('GET',f'/admin/privacy/requests/{rid}',token=at)[1]['request']['status']=='in_review'
public=call('GET',f'/privacy/requests/{rid}/redacted',token=token)[1];assert len(public['items'])==1
assert all(x not in json.dumps(public) for x in ['source_id','ranges','source_sha256','SECRET','created_by'])
assert call('GET',f'/privacy/requests/{rid}/redacted',token=ot)[1]['items']==[]
assert download(pid,ot)[0]==404 and download(pid,pwd='wrong')[0]==401
s,data,h=download(pid);assert s==200
decoded=json.loads(data);assert decoded['text']==p['text'] and 'SECRET' not in data.decode() and 'source_sha256' not in data.decode()
assert h['Content-Type']=='application/octet-stream' and 'attachment' in h['Content-Disposition']
assert h['Cache-Control']=='no-store, private' and h['X-Content-Type-Options']=='nosniff'
check('concurrent issue is single, password/ownership enforced, public metadata and file contain only approved text')
assert sql('SELECT body FROM chat_messages WHERE id=%s',(sid,))==text
assert sql('SELECT owner_id FROM devices WHERE id=%s',(did,))==uid
try:sql("UPDATE privacy_redacted_deliveries SET ranges='[]' WHERE id=%s",(pid,));raise AssertionError('immutable guard missing')
except psycopg2.Error:pass
try:sql('DELETE FROM privacy_redacted_events WHERE delivery_id=%s',(pid,));raise AssertionError('audit guard missing')
except psycopg2.Error:pass
check('issued selections and audit cannot be edited; raw body and SIM ownership unchanged')
assert review()[0]==200;s,new,_=issue(select());assert s==200;pid2=new['id']
assert download(pid)[0]==410
sql("UPDATE chat_messages SET body=body||' changed' WHERE id=%s",(sid,));assert download(pid2)[0]==409
sql('UPDATE chat_messages SET body=%s WHERE id=%s',(text,sid))
assert call('POST',f'/admin/privacy/redacted/{pid2}/revoke',{},at)[0]==200
assert download(pid2)[0]==410
check('replacement revokes previous grant; source changes and explicit revocation stop download')
assert review('ai',aid)[0]==200;s,new,_=issue(select('ai',aid));assert s==200;apid=new['id']
# Data remains bound to original analysis user, independent of current SIM owner.
sql('UPDATE devices SET owner_id=%s WHERE id=%s',(other['user_id'],did))
sql('DELETE FROM privacy_result_limits')
assert download(apid)[0]==200 and download(apid,ot)[0]==404
sql('DELETE FROM ai_analyses WHERE id=%s',(aid,));assert download(apid)[0]==409
check('AI follows stored account, never current SIM owner; deleted source fails closed')
# Expiry via isolated DB fixture; do not weaken production constraints.
sql('ALTER TABLE privacy_redacted_deliveries DISABLE TRIGGER privacy_redacted_immutable')
sql("UPDATE privacy_redacted_deliveries SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=%s",(apid,))
sql('ALTER TABLE privacy_redacted_deliveries ENABLE TRIGGER privacy_redacted_immutable')
assert download(apid)[0]==410
assert review()[0]==200;s,new,_=issue(select());assert s==200;pid3=new['id']
assert call('POST',f'/privacy/requests/{rid}/cancel',{'revision':revision()},token)[0]==200
assert download(pid3)[0]==410 and review()[0]==409
assert call('POST',f'/admin/privacy/redacted/{pid3}/revoke',{},at)[0]==200
check('expiry and parent cancellation block further review and download; revocation remains available')
r=intake();rid=r['id'];basepath=f'/admin/privacy/requests/{rid}';assert review()[0]==200;s,new,_=issue(select());assert s==200;last=new['id']
sql('UPDATE privacy_account_controls SET restricted=true WHERE user_id=%s',(uid,))
assert download(last)[0]==401 and review()[0]==403
check('closed subject account blocks raw review and downloads; existing audit retained without body copies')
assert len(passed)==8
result={'integration_groups':len(passed),'groups':passed,'api_sha256':digest,'schema':sql('SELECT max(version) FROM _sqlx_migrations')}
(pathlib.Path(__file__).parent/'redacted-validation.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
