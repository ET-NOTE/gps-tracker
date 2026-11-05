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
def chunk(k,v):return struct.pack('>I',len(v))+k+v+struct.pack('>I',zlib.crc32(k+v)&0xffffffff)
def png(raw=b'\xff\x00\x00\x63\x58\x4d',w=2,h=1,color=2,extra=b''):
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,color,0,0,0))+extra+chunk(b'IDAT',zlib.compress(b'\0'+raw))+chunk(b'IEND',b'')
original=png();staff=sql("INSERT INTO staff(user_id,name,access_role) VALUES(%s,'Receipt fixture','member') RETURNING id",(oid,))
staff2=sql("INSERT INTO staff(user_id,name,access_role) VALUES(%s,'Other staff','member') RETURNING id",(oid,))
category=sql("SELECT id FROM fleet_expense_categories WHERE owner_id=%s AND kind='expense' ORDER BY id LIMIT 1",(oid,))
def expense(staff_id=staff,day='2026-01-01',status='pending'):
 return sql("INSERT INTO fleet_expenses(owner_id,created_by,request_id,request_value,spent_on,category_id,category_name,group_name,category_kind,staff_id,staff_name,department_name,vehicle_name,amount_krw,payment_method,status) VALUES(%s,%s,%s,'{}',%s,%s,'Fuel fixture','Test','expense',%s,'Hidden name','Hidden department','',1000,'cash',%s) RETURNING id",(oid,oid,str(uuid.uuid4()),day,category,staff_id,status))
def attach(e,content=original,mime='image/png'):
 return sql("INSERT INTO fleet_expense_receipts(owner_id,expense_id,filename,mime,content,digest) VALUES(%s,%s,'PRIVATE_FILENAME',%s,%s,%s) RETURNING id",(oid,e,mime,content,hashlib.sha256(content).hexdigest()))
e=expense();f=attach(e)
excluded=[attach(expense(staff2)),attach(expense(day='2025-12-31')),attach(expense(day='2026-01-02')),attach(expense(status='cancelled')),attach(expense(),b'%PDF fixture','application/pdf')]
removed=attach(expense());sql('UPDATE fleet_expense_receipts SET removed_at=now() WHERE id=%s',(removed,));excluded.append(removed)
s,c,_=call('POST',path+'/company-reviews',{'revision':revision(),'company_owner_id':oid,'staff_id':staff,'category':'expenses','from_at':'2026-01-01T00:00:00+09:00','until_at':'2026-01-02T00:00:00+09:00','due_at':due},at);assert s==200,(s,c);cr=c['id']
def company_state():return next(x for x in call('GET',path+'/company-reviews',token=at)[1]['items'] if x['id']==cr)
def confirm():
 c=company_state();s,v,_=call('PATCH',f'/admin/privacy/company-reviews/{cr}',{'request_revision':revision(),'revision':c['revision'],'status':'in_review','identity':'confirmed','identity_evidence':'SYNTHETIC staff match','evidence_reference':'','internal_reason':'fixture','public_message':'Reviewing','due_at':due,'outcome':'','confirmed':False},at);assert s==200,(s,v);return company_state()['revision']
def listing(who=at,after=0):return call('GET',path+f'/receipt-sources/{cr}?company_revision={company_state()["revision"]}&after={after}',token=who)
def read(fid=f,who=at):
 sql('DELETE FROM privacy_result_limits');return call('POST',path+f'/receipt-sources/{cr}/{fid}',{'company_revision':company_state()['revision']},who)
assert listing()[0]==409 and read()[0]==409
rev=confirm();assert listing(token)[0]==403 and read(who=token)[0]==403
s,items,h=listing();assert s==200 and [v['id'] for v in items['items']]==[f] and h['Cache-Control']=='no-store, private'
assert not any(x in json.dumps(items) for x in ['PRIVATE_FILENAME','Hidden name','content','digest'])
for fid in excluded:assert read(fid)[0]==409
check('admin-only confirmed staff/date scope; wrong staff, outside dates, cancelled, removed, PDF excluded; no raw metadata in listing')
b={**selection(),'receipt':{'id':f,'receipt_revision':1,'expense_revision':1},'company_review_id':cr,'company_revision':rev,'source_sha256':hashlib.sha256(original).hexdigest()}
assert preview(b)[0]==409
s,raw,h=read();assert s==200,(s,raw);display=base64.b64decode(raw['data_base64']);assert raw['display_sha256']==hashlib.sha256(display).hexdigest() and png_pixels(display)==bytes([255,0,0,99,88,77])
assert sql('SELECT count(*) FROM privacy_receipt_reads WHERE receipt_id=%s',(f,))==1
b['receipt']=raw['receipt'];b['rgb_base64']=base64.b64encode(bytes([0,255,0,255,255,255])).decode()
s,p,_=preview(b);assert s==200,(s,p);assert png_pixels(base64.b64decode(p['png_base64']))==bytes([255,0,0,0,0,0])
assert preview({**b,'width':1})[0]==400
assert preview({**b,'source_sha256':'a'*64})[0]==409
assert preview({**b,'receipt':{**b['receipt'],'receipt_revision':0}})[0]==409
s,d,_=issue(b);assert s==200,(s,d);did=d['id'];assert download(did)[0]==200 and download(did,ot)[0]==404
assert sql('SELECT content FROM fleet_expense_receipts WHERE id=%s',(f,)).tobytes()==original
assert not any(k in json.dumps(call('GET',f'/privacy/requests/{rid}/images',token=token)[1]) for k in ['receipt_id','source_sha256','expense_revision'])
check('same-admin read proof; original hash/version binding; forged RGB ignored; actual output comes from server source; original unchanged')
# Changes invalidate and synchronously remove only the derived delivery bytes.
sql("UPDATE fleet_expenses SET note='edited' WHERE id=%s",(e,))
assert download(did)[0]==409 and sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s',(did,))==0
assert preview(b)[0]==409
def fresh():
 s,r,_=read(f);assert s==200;return {**b,'receipt':r['receipt'],'source_sha256':r['sha256'],'company_revision':company_state()['revision']}
b=fresh();s,d,_=issue(b);assert s==200;did=d['id']
sql('UPDATE fleet_expense_receipts SET removed_at=now() WHERE id=%s',(f,));assert download(did)[0]==409
assert sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s',(did,))==0
assert sql('SELECT octet_length(content) FROM fleet_expense_receipts WHERE id=%s',(f,))==len(original)
sql('UPDATE fleet_expense_receipts SET removed_at=NULL WHERE id=%s',(f,));assert download(did)[0]==409
b=fresh();s,d,_=issue(b);assert s==200;did=d['id'];sql('UPDATE fleet_expenses SET staff_id=%s WHERE id=%s',(staff2,e))
assert read()[0]==409 and download(did)[0]==409 and sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s',(did,))==0
sql('UPDATE fleet_expenses SET staff_id=%s WHERE id=%s',(staff,e));assert download(did)[0]==409
check('expense edits, receipt removal and staff reassignment purge derived bytes; restoration cannot resurrect old deliveries; originals retained')
b=fresh();s,d,_=issue(b);assert s==200;did=d['id'];sql('DELETE FROM fleet_expense_receipts WHERE id=%s',(f,))
assert download(did)[0]==409 and sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s',(did,))==0
assert sql('SELECT count(*) FROM privacy_receipt_reads WHERE receipt_id=%s',(f,))>0
try:sql('DELETE FROM privacy_receipt_reads WHERE receipt_id=%s',(f,));raise AssertionError('audit mutable')
except psycopg2.Error:pass
check('source deletion allowed without audit FK blockage; audit immutable; deleted source denies old grants')
# Decoder input limits and transparent pixels. No read proof is recorded on decode failure.
alpha=attach(expense(),png(bytes([9,8,7,0,255,0,0,128]),color=6));s,r,_=read(alpha);assert s==200 and png_pixels(base64.b64decode(r['data_base64']))==bytes([255,255,255,255,127,127])
palette=attach(expense(),png(bytes([0,1]),color=3,extra=chunk(b'PLTE',bytes([255,0,0,0,255,0]))));assert read(palette)[0]==200
for content in [b'\x89PNG\r\n\x1a\nBAD',png(w=2049),png(extra=chunk(b'acTL',struct.pack('>II',1,0)))]:
 fid=attach(expense(),content);assert read(fid)[0]==400;assert sql('SELECT count(*) FROM privacy_receipt_reads WHERE receipt_id=%s',(fid,))==0
jpeg=base64.b64decode('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==');fid=attach(expense(),jpeg,'image/jpeg');s,r,_=read(fid);assert s==200,(s,r);assert r['mime']=='image/png' and len(png_pixels(base64.b64decode(r['data_base64'])))==6
assert r['sha256']==hashlib.sha256(jpeg).hexdigest() and r['display_sha256']!=r['sha256']
check('PNG alpha/palette and JPEG decode on server; normalized PNG contains no source metadata; malformed/oversized/APNG rejected before read proof')
f=attach(expense());b=fresh();s,d,_=issue(b);assert s==200;did=d['id'];confirm()
assert preview(b)[0]==409 and download(did)[0]==409 and sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s',(did,))==0
check('company re-review invalidates source selection and issued delivery immediately')
for i in range(52):attach(expense())
s,first,_=listing();assert s==200 and len(first['items'])==50 and first['next']
s,second,_=listing(after=first['next']);assert s==200 and not(set(v['id'] for v in first['items'])&set(v['id'] for v in second['items']))
sql('UPDATE privacy_account_controls SET restricted=true WHERE user_id=%s',(oid,));assert listing()[0]==403 and read(f)[0]==403
check('bounded keyset pagination; restricted company blocks source reads')
report={'integration_groups':len(passed),'groups':passed,'api_sha256':digest,'schema':sql('SELECT max(version) FROM _sqlx_migrations')}
(pathlib.Path(__file__).parent/'receipts-validation.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
