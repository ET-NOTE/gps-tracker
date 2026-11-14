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
tag=uuid.uuid4().hex[:12];password='delivery-fixture-only-9!';passed=[]
def sql(q,args=()):
 with db.cursor() as c:
  c.execute(q,args);return c.fetchone()[0] if c.description else None
def call(method,path,body=None,token=None,extra=None):
 global last_body
 h={'Content-Type':'application/json',**(extra or {})}
 if token:h['Authorization']='Bearer '+token
 try:r=urllib.request.urlopen(urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers=h),timeout=20)
 except urllib.error.HTTPError as e:r=e
 with r:
  data=r.read();last_body=data;return r.status,json.loads(data) if 'application/json' in r.headers.get('content-type','') else data,r.headers
def check(s):passed.append(s);print('PASS '+s,flush=True)
def account(n):
 email=f'{tag}-{n}@example.invalid';phone='010'+str(int(tag,16)+n)[-8:]
 s,otp,_=call('POST','/auth/send-otp',{'phone':phone});assert s==200
 s,row,_=call('POST','/auth/register',{'email':email,'phone':phone,'otp_code':otp['dev_code'],'password':password,'display_name':'delivery fixture'});assert s==200,(s,row)
 row['email']=email;return row
owner,other,admin=[account(n) for n in [31,32,33]];uid=owner['user_id'];token=owner['access_token'];at=admin['access_token']
sql("UPDATE users SET role='admin' WHERE id=%s",(admin['user_id'],))
def device(n,user):return sql("INSERT INTO devices(device_uid,owner_id,api_key_hash,display_name) VALUES(%s,%s,'fixture','=unsafe-name') RETURNING id",(f'{tag}-sim-{n}',user))

d1=device(1,uid);d2=device(2,other['user_id']);dc=device(3,uid)
vehicle=sql("INSERT INTO fleet_vehicles(owner_id,name) VALUES(%s,'company fixture') RETURNING id",(uid,))
sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,started_at) VALUES(%s,%s,%s,'company',now())",(vehicle,uid,dc))
root=pathlib.Path(cfg['UPLOAD_DIR']);assert pathlib.Path(__file__).parent in root.parents
def upload(did,user,name='own.pdf',data=b'%PDF-1.4 synthetic personal document',path=None):
 path=path or root/'device_documents'/str(user)/str(did)/(uuid.uuid4().hex+'_'+name)
 path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
 doc=sql("INSERT INTO device_documents(user_id,device_id,kind,filename,stored_path,mime,size_bytes) VALUES(%s,%s,'other',%s,%s,'application/pdf',%s) RETURNING id",(user,did,name,str(path),len(data)))
 return doc,path
good,goodpath=upload(d1,uid);foreign,_=upload(d2,other['user_id']);company,_=upload(dc,uid)
old,_=upload(d2,uid)
shared,sharedpath=upload(d1,uid)
sql("INSERT INTO device_documents(user_id,device_id,kind,filename,stored_path,mime,size_bytes) VALUES(%s,%s,'other','shared.pdf',%s,'application/pdf',%s)",(other['user_id'],d2,str(sharedpath),sharedpath.stat().st_size))
sql("UPDATE users SET secondary_phone='fixture-secondary',prefs='{\"private_key\":\"must-not-leak\"}' WHERE id=%s",(uid,))
s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'access','scope':'Synthetic account and personal document access','password':password},token);assert s==202
rid=r['id']
def detail():return call('GET',f'/admin/privacy/requests/{rid}',token=at)[1]['request']
def grant(docs=None,revision=None,confirmed=True,who=at):
 return call('POST',f'/admin/privacy/requests/{rid}/account-packages',{'revision':revision or detail()['revision'],'confirmed':confirmed,'documents':docs or []},who)
def dl(p,docid=None,who=token,pw=password,extra=None):
 return call('POST',f"/privacy/account-packages/{p['id']}/"+(f'documents/{docid}' if docid else 'account'),{'password':pw},who,extra)
def revdoc(did):return call('POST',f'/admin/privacy/requests/{rid}/documents/{did}/review',{},at)
assert grant()[0]==409
s,r,_=call('PATCH',f'/admin/privacy/requests/{rid}',{'revision':r['revision'],'status':'in_review','message':'Public scope review','evidence_reference':'PRIVATE-OPERATOR-EVIDENCE','due_at':(datetime.now(timezone.utc)+timedelta(days=4)).isoformat()},at);assert s==200
assert grant(confirmed=False)[0]==400 and grant(who=token)[0]==403
s,opts,_=call('GET',f'/admin/privacy/requests/{rid}/personal-documents',token=at);assert s==200 and [d['id'] for d in opts['items']]==[good],(s,opts)
for did in [foreign,company,old,shared]:assert revdoc(did)[0]==409
assert grant([{'id':good,'sha256':hashlib.sha256(goodpath.read_bytes()).hexdigest()}])[0]==409
s,data,h=revdoc(good);assert s==200 and data==goodpath.read_bytes() and h['Content-Disposition'].startswith('attachment;')
proof={'id':good,'sha256':h['x-document-sha256']}
s,p,_=grant([proof]);assert s==200,(s,p)
assert grant([proof],revision=r['revision'])[0]==409
check('admin review gate, evidence-bound selection and personal/company/shared/uploader boundaries')
assert dl(p,who=None)[0]==401 and dl(p,who=other['access_token'])[0]==404
assert dl(p,pw='wrong')[0]==401 and dl(p,extra={'X-Fleet-Owner':str(uid)})[0]==403
assert call('GET',f'/privacy/requests/{rid}/account-packages',token=other['access_token'])[1]==[]
s,data,h=dl(p);assert s==200,(s,data);raw=last_body
assert data['format']=='gps-personal-account-v1' and data['account']['email']==owner['email'] and data['account']['secondary_phone']=='fixture-secondary'
assert set(data['account'])=={'email','display_name','phone','secondary_phone','phone_verified','created_at','updated_at'}
assert data['requests'][0]['id']==rid and data['reviewed_documents'][0]['id']==good
for secret in [b'PRIVATE-OPERATOR-EVIDENCE',b'must-not-leak',b'password_hash',b'stored_path',other['email'].encode()]:assert secret not in raw
assert h['Cache-Control']=='no-store, private' and h['X-Content-Type-Options']=='nosniff'
assert sql("SELECT sha256 FROM privacy_account_package_events WHERE package_id=%s AND action='account_prepared' ORDER BY id DESC LIMIT 1",(p['id'],))==hashlib.sha256(raw).hexdigest()
s,data,h=dl(p,good);assert s==200 and data==goodpath.read_bytes() and h['Content-Type']=='application/octet-stream'
assert dl(p,foreign)[0]==404
check('owner/password/delegation checks, public whitelist, exact binary response, hash audit and no-store')
original=goodpath.read_bytes();goodpath.write_bytes(b'x'*len(original));assert dl(p,good)[0]==409;goodpath.write_bytes(original)
sql('UPDATE devices SET owner_id=%s WHERE id=%s',(other['user_id'],d1));assert dl(p,good)[0]==409
sql('UPDATE devices SET owner_id=%s WHERE id=%s',(uid,d1))
sql('UPDATE device_data_controls SET blocked=true WHERE device_id=%s',(d1,));assert dl(p,good)[0]==409
sql('UPDATE device_data_controls SET blocked=false WHERE device_id=%s',(d1,))
sql("INSERT INTO fleet_vehicle_bindings(vehicle_id,owner_id,device_id,terminal_name,started_at) VALUES(%s,%s,%s,'late',now())",(vehicle,uid,d1));assert dl(p,good)[0]==409
sql('DELETE FROM fleet_vehicle_bindings WHERE device_id=%s',(d1,))
check('changed contents, transferred SIM, erasure gate and late company assignment refuse files')
sql('DELETE FROM privacy_result_limits')
# Never follow final or parent symlinks, hardlinks or directories outside the upload tree.
outside=pathlib.Path(__file__).parent/'test-storage/outside.pdf';outside.write_bytes(original)
goodpath.unlink();goodpath.symlink_to(outside);assert revdoc(good)[0]==409;goodpath.unlink();goodpath.hardlink_to(outside);assert revdoc(good)[0]==409;goodpath.unlink();goodpath.write_bytes(original)
parent=goodpath.parent;renamed=parent.with_name(parent.name+'-moved');parent.rename(renamed);parent.symlink_to(renamed,target_is_directory=True);assert revdoc(good)[0]==409;parent.unlink();renamed.rename(parent)
sql('UPDATE device_documents SET stored_path=%s WHERE id=%s',(str(outside),good));assert revdoc(good)[0]==409
sql('UPDATE device_documents SET stored_path=%s WHERE id=%s',(str(goodpath),good));assert revdoc(good)[0]==200
sql('UPDATE device_documents SET size_bytes=10485761 WHERE id=%s',(good,));assert revdoc(good)[0]==409
sql('UPDATE device_documents SET size_bytes=%s WHERE id=%s',(len(original),good))
check('no-follow path walk, hardlink/root containment and bounded file size')
s,fresh,_=grant();assert s==200 and dl(p)[0]==410
assert call('POST',f"/admin/privacy/account-packages/{fresh['id']}/revoke",{},at)[0]==200 and dl(fresh)[0]==410
s,p,_=grant();sql("UPDATE privacy_account_packages SET created_at=now()-interval '25 hours',expires_at=now()-interval '1 hour' WHERE id=%s",(p['id'],));assert dl(p)[0]==410
s,p,_=grant();assert s==200
check('reissue revokes previous grant, explicit revocation and expiry')
sql('DELETE FROM privacy_result_limits')
# Never silently trim a supposedly complete history.
sql("INSERT INTO privacy_request_events(request_id,actor_id,revision,status,message) SELECT %s,%s,10000+n,'in_review','bounded fixture' FROM generate_series(1,2001) n",(rid,uid))
assert dl(p)[0]==409
sql('DELETE FROM privacy_request_events WHERE request_id=%s AND revision>=10000',(rid,))
assert dl(p)[0]==200
check('oversized processing history refuses partial export')
revision=detail()['revision']
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
 responses=list(pool.map(lambda _:grant(revision=revision),range(2)))
assert sorted(x[0] for x in responses)==[200,409],responses
p=next(x[1] for x in responses if x[0]==200)
subprocess.run(['docker','restart',API],check=True,stdout=subprocess.DEVNULL)
for _ in range(30):
 try:
  if dl(p)[0]==200:break
 except urllib.error.URLError:pass
 time.sleep(1)
else:raise AssertionError('restart failed')
check('concurrent issue serializes by parent revision; delivery survives restart')
sql('UPDATE privacy_account_controls SET restricted=true WHERE user_id=%s',(uid,));assert dl(p)[0]==401
assert grant()[0]==403
s,result,_=call('POST','/privacy/result',{'email':owner['email'],'password':password,'request_id':rid});assert s==200 and result['account_restricted']
assert 'account' not in result and 'documents' not in result
sql('UPDATE privacy_account_controls SET restricted=false WHERE user_id=%s',(uid,))
s,_,_=call('POST',f'/privacy/requests/{rid}/cancel',{'revision':detail()['revision']},token);assert s==200 and dl(p)[0]==410
check('account closure cannot restore data access; result-only scope and cancelled requests remain closed')
# Fresh grant on another request to exercise the shared password throttle.
s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'access','scope':'Rate limit fixture','password':password},token);assert s==202
rid=r['id'];s,r,_=call('PATCH',f'/admin/privacy/requests/{rid}',{'revision':r['revision'],'status':'in_review','message':'scope','evidence_reference':'fixture','due_at':(datetime.now(timezone.utc)+timedelta(days=4)).isoformat()},at);assert s==200
s,p,_=grant();assert s==200
sql('DELETE FROM privacy_result_limits')
with concurrent.futures.ThreadPoolExecutor(max_workers=11) as pool:statuses=list(pool.map(lambda _:dl(p,pw='wrong')[0],range(11)))
assert statuses.count(401)==10 and statuses.count(429)==1,statuses
check('password reauthentication shares atomic account/IP rate limits')
sql('DELETE FROM privacy_result_limits')
result={'integration_groups':len(passed),'groups':passed,'api_sha256':digest,'schema':sql('SELECT max(version) FROM _sqlx_migrations')}
(pathlib.Path(__file__).parent/'packages-validation.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
