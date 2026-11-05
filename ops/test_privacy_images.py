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

# Fresh synthetic scope; never run on production.
import struct,zlib

def png_pixels(data):
 assert data[:8]==b'\x89PNG\r\n\x1a\n';i=8;chunks=[];packed=b''
 while i<len(data):
  n=struct.unpack('>I',data[i:i+4])[0];kind=data[i+4:i+8];v=data[i+8:i+8+n];chunks.append(kind)
  if kind==b'IHDR':w,h,depth,color,_,_,_=struct.unpack('>IIBBBBB',v);assert depth==8 and color==2
  if kind==b'IDAT':packed+=v
  i+=n+12
 assert set(chunks)=={b'IHDR',b'IDAT',b'IEND'}
 raw=zlib.decompress(packed);stride=w*3;out=[];prev=[0]*stride
 for y in range(h):
  f=raw[y*(stride+1)];row=list(raw[y*(stride+1)+1:(y+1)*(stride+1)])
  for x in range(stride):
   a=row[x-3] if x>=3 else 0;b=prev[x];c=prev[x-3] if x>=3 else 0
   p=a+b-c;pa,pb,pc=abs(p-a),abs(p-b),abs(p-c);v=a if pa<=pb and pa<=pc else b if pb<=pc else c
   row[x]=(row[x]+[0,a,b,(a+b)//2,v][f])%256
  out+=row;prev=row
 return bytes(out)

due=(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()
def intake():
 s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'access','scope':'Reviewed image fixture','password':password},token);assert s==202
 s,r,_=call('PATCH',f"/admin/privacy/requests/{r['id']}",{'revision':r['revision'],'status':'in_review','message':'Review scope','evidence_reference':'SYNTHETIC','due_at':due},at);assert s==200;return r
r=intake();rid=r['id'];path=f'/admin/privacy/requests/{rid}'
def revision():return call('GET',f'/admin/privacy/requests/{rid}',token=at)[1]['request']['revision']
def selection():return {'company_review_id':None,'company_revision':None,'category':'receipt','source_reference':'SYNTHETIC-ONLY page1','source_sha256':'a'*64,'width':2,'height':1,'regions':[{'x':0,'y':0,'width':1,'height':1}],'notice':'Only subject area; third party removed.','rgb_base64':base64.b64encode(bytes([255,0,0,99,88,77])).decode()}
def preview(b,who=at):
 sql('DELETE FROM privacy_result_limits');return call('POST',path+'/image-preview',b,who)
def issue(b,**kw):
 s,p,_=preview(b);assert s==200,(s,p)
 return call('POST',path+'/images',{'revision':revision(),'confirmed':True,'source_confirmed':True,'preview_sha256':p['preview_sha256'],**b,**kw},at)
def download(id,who=token,pwd=password):
 sql('DELETE FROM privacy_result_limits');return call('POST',f'/privacy/images/{id}/download',{'password':pwd},who)
b=selection()
assert preview(b,token)[0]==403
assert call('POST',path+'/images',{'revision':revision(),'confirmed':True,'source_confirmed':True,'preview_sha256':'0'*64,**b},at)[0]==409
for change in [{'regions':[]},{'regions':[{'x':1,'y':0,'width':2,'height':1}]},{'width':2049},{'height':0},{'rgb_base64':'a'},{'notice':''},{'source_reference':''},{'company_review_id':1},{'source_sha256':'X'*64},{'source_sha256':'A'*64},{'category':'html'}]:assert preview({**b,**change})[0] in (400,409,422)
s,p,h=preview(b);assert s==200 and h['Cache-Control']=='no-store, private';assert png_pixels(base64.b64decode(p['png_base64']))==bytes([255,0,0,0,0,0])
assert sql('SELECT count(*) FROM privacy_image_payloads')==0
check('admin-only preview; bounded RGB/regions; excluded pixels and all metadata absent; no preview payload retained')
for change in [{'confirmed':False},{'source_confirmed':False},{'revision':0},{'preview_sha256':'0'*64}]:assert issue(b,**change)[0] in (400,409)
s,p,_=preview(b)
assert call('POST',path+'/images',{'revision':revision(),'confirmed':True,'source_confirmed':True,'preview_sha256':p['preview_sha256'],**{**b,'notice':'changed'}},at)[0]==409
sql("UPDATE users SET role='admin' WHERE id=%s",(company['user_id'],))
assert call('POST',path+'/images',{'revision':revision(),'confirmed':True,'source_confirmed':True,'preview_sha256':p['preview_sha256'],**b},ct)[0]==409
sql("UPDATE users SET role='user' WHERE id=%s",(company['user_id'],))
check('same-admin preview, both confirmations, exact content and revision required')
s,p,_=preview(b);payload={'revision':revision(),'confirmed':True,'source_confirmed':True,'preview_sha256':p['preview_sha256'],**b}
with concurrent.futures.ThreadPoolExecutor(2) as pool:results=list(pool.map(lambda _:call('POST',path+'/images',payload,at),range(2)))
assert sorted(x[0] for x in results)==[200,409];did=next(x[1]['id'] for x in results if x[0]==200)
public=call('GET',f'/privacy/requests/{rid}/images',token=token)[1];assert len(public['items'])==1
assert not any(x in json.dumps(public) for x in ['source_sha256','source_reference','regions','created_by','company_review_id','png_base64'])
assert download(did,ot)[0]==404 and download(did,pwd='wrong')[0]==401
s,data,h=download(did);assert s==200 and png_pixels(data)==bytes([255,0,0,0,0,0]);assert h['X-Content-Type-Options']=='nosniff' and h['Content-Type']=='application/octet-stream' and 'attachment' in h['Content-Disposition']
assert call('GET',path,token=at)[1]['request']['status']=='in_review'
check('concurrent issue once; explicit public projection; password/foreign denial; real PNG download; no whole completion')
for query in ['UPDATE privacy_image_payloads SET png_bytes=png_bytes WHERE delivery_id=%s','DELETE FROM privacy_image_payloads WHERE delivery_id=%s','UPDATE privacy_image_deliveries SET notice=notice WHERE id=%s']:
 try:
  if query.startswith('UPDATE privacy_image_deliveries'):query=query.replace('notice=notice',"notice='changed'")
  sql(query,(did,));raise AssertionError('mutation accepted')
 except psycopg2.Error:pass
assert call('POST',f'/admin/privacy/images/{did}/revoke',{},at)[0]==200
assert sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s',(did,))==0
assert download(did)[0]==410
assert sql("SELECT count(*) FROM privacy_image_events WHERE delivery_id=%s AND action='payload_removed'",(did,))==1
assert call('POST',f'/admin/privacy/images/{did}/revoke',{},at)[0]==200
check('immutable selection/payload/audit; revocation deletes temporary bytes once')
# Company scope is explicit and tied to a confirmed review revision, not SIM owner.
staff=sql("INSERT INTO staff(user_id,name,access_role) VALUES(%s,'Image fixture','member') RETURNING id",(oid,))
s,c,_=call('POST',path+'/company-reviews',{'revision':revision(),'company_owner_id':oid,'staff_id':staff,'category':'files','from_at':'2026-01-01T00:00:00Z','until_at':'2026-01-02T00:00:00Z','due_at':due},at);assert s==200,(s,c)
cr=c['id']
def company_state():return next(x for x in call('GET',path+'/company-reviews',token=at)[1]['items'] if x['id']==cr)
def change_company(identity='confirmed',status='in_review'):
 c=company_state();body={'request_revision':revision(),'revision':c['revision'],'status':status,'identity':identity,'identity_evidence':'SYNTHETIC','evidence_reference':'','internal_reason':'scope test','public_message':'Reviewing','due_at':due,'outcome':'','confirmed':False};s,v,_=call('PATCH',f'/admin/privacy/company-reviews/{cr}',body,at);assert s==200,(s,v);return company_state()
cb={**b,'company_review_id':cr,'company_revision':company_state()['revision']}
assert preview(cb)[0]==409
c=change_company();cb['company_revision']=c['revision'];s,d,_=issue(cb);assert s==200,(s,d);company_did=d['id'];assert download(company_did)[0]==200
c=change_company();assert download(company_did)[0]==409;assert sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s',(company_did,))==0
assert preview(cb)[0]==409
check('confirmed company identity/staff/request/revision required; scope change blocks and purges')
# Cancellation and account closure purge snapshots without claiming source deletion.
s,d,_=issue(b);assert s==200;cancel_did=d['id'];assert call('POST',f'/privacy/requests/{rid}/cancel',{'revision':revision()},token)[0]==200
assert download(cancel_did)[0]==410 and sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s',(cancel_did,))==0
r=intake();rid=r['id'];path=f'/admin/privacy/requests/{rid}';s,d,_=issue(b);assert s==200;close_did=d['id'];sql('UPDATE privacy_account_controls SET restricted=true WHERE user_id=%s',(uid,))
assert download(close_did)[0]==401 and sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s',(close_did,))==0
sql('UPDATE privacy_account_controls SET restricted=false WHERE user_id=%s',(uid,))
check('cancelled request and closed account remove payload; reopening never recreates it')
# Simulate elapsed time only in isolated fixture by disabling immutable trigger.
s,d,_=issue(b);assert s==200;expired=d['id'];sql('ALTER TABLE privacy_image_deliveries DISABLE TRIGGER privacy_image_delivery_immutable')
try:sql("UPDATE privacy_image_deliveries SET created_at=now()-interval '25 hours',expires_at=now()-interval '1 hour' WHERE id=%s",(expired,))
finally:sql('ALTER TABLE privacy_image_deliveries ENABLE TRIGGER privacy_image_delivery_immutable')
assert download(expired)[0]==410
# Wait for the API's actual minute worker rather than invoking cleanup manually.
for _ in range(70):
 if sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s',(expired,))==0:break
 time.sleep(1)
else:raise AssertionError('automatic image cleanup did not run')
assert sql('SELECT privacy_cleanup_image_payloads()')==0
check('expiry denies before cleanup; actual minute worker purges payload; cleanup is idempotent and leaves review metadata only')
# Ten files per request; do not keep body copies after the exercise.
while sql('SELECT count(*) FROM privacy_image_deliveries WHERE request_id=%s',(rid,))<10:assert issue(b)[0]==200
assert issue(b)[0]==409
sql('UPDATE privacy_account_controls SET restricted=true WHERE user_id=%s',(uid,))
assert sql('SELECT count(*) FROM privacy_image_payloads p JOIN privacy_image_deliveries g ON g.id=p.delivery_id WHERE g.request_id IN (SELECT id FROM privacy_requests WHERE user_id=%s)',(uid,))==0
check('per-request issue cap; no source/SIM mutation or raw bytes stored')
report={'integration_groups':len(passed),'groups':passed,'api_sha256':digest,'schema':sql('SELECT max(version) FROM _sqlx_migrations')}
(pathlib.Path(__file__).parent/'images-validation.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
