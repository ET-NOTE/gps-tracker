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
p=pathlib.Path('/home/mmm/gps-artifacts/privacy-receipts-20261106-r1')
private=p/'smoke-private.json';c=json.loads(private.read_text())
assert c['email'].startswith('account-smoke-') and c['email'].endswith('@example.invalid')
cfg=config('/home/mmm/projects/gps-tracker-api/.env')
with urllib.request.urlopen('https://gps.serial.kr/health') as response:health=json.load(response)
assert health['release']=='privacy-receipts-20261106-r1' and health['environment']=='production'
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


assert not c.get('users'), 'run once; inspect private checkpoint before retry'
c['baseline']=guard();c['users']=[]
for suffix in ['', '-other', '-company']:
 email=c['email'].replace('@',suffix+'@')
 uid=sql("INSERT INTO users(email,password_hash,display_name,phone,phone_verified) VALUES(%s,%s,'이미지 부분 제공 모의 검증','01000000000',false) RETURNING id",(email,c['password_hash']));c['users'].append(uid);private.write_text(json.dumps(c))
uid,other,owner=c['users']
s,login,_=call('POST','/auth/login',{'email':c['email'],'password':c['password']});assert s==200;token=login['access_token']

due=(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()
s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'access','scope':'모의 영수증의 본인 영역만 이미지로 제공하는 검증','password':c['password']},token);assert s==202
rid=r['id'];c['request_id']=rid;private.write_text(json.dumps(c))
s,r,_=call('PATCH',f'/admin/privacy/requests/{rid}',{'revision':r['revision'],'status':'in_review','message':'합성 영수증 범위를 검토합니다.','evidence_reference':'ROUND14-SYNTHETIC','due_at':due},at);assert s==200
path=f'/admin/privacy/requests/{rid}'
staff=sql("INSERT INTO staff(user_id,name,access_role) VALUES(%s,'모의 검증 직원','member') RETURNING id",(owner,))
category=sql("SELECT id FROM fleet_expense_categories WHERE owner_id=%s AND kind='expense' ORDER BY id LIMIT 1",(owner,))
expense=sql("INSERT INTO fleet_expenses(owner_id,created_by,request_id,request_value,spent_on,category_id,category_name,group_name,category_kind,staff_id,staff_name,department_name,vehicle_name,amount_krw,payment_method) VALUES(%s,%s,%s,'{}','2026-01-01',%s,'모의 항목','모의 분류','expense',%s,'모의 직원','','',1000,'cash') RETURNING id",(owner,owner,str(uuid.uuid4()),category,staff))
def chunk(k,v):return struct.pack('>I',len(v))+k+v+struct.pack('>I',zlib.crc32(k+v)&0xffffffff)
source=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',2,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(bytes([0,255,0,0,99,88,77])))+chunk(b'IEND',b'')
receipt=sql("INSERT INTO fleet_expense_receipts(owner_id,expense_id,filename,mime,content,digest) VALUES(%s,%s,'synthetic.png','image/png',%s,%s) RETURNING id",(owner,expense,source,hashlib.sha256(source).hexdigest()))
c.update(expense_id=expense,receipt_id=receipt);private.write_text(json.dumps(c))
s,review,_=call('POST',path+'/company-reviews',{'revision':detail(rid)['revision'],'company_owner_id':owner,'staff_id':staff,'category':'expenses','from_at':'2026-01-01T00:00:00+09:00','until_at':'2026-01-02T00:00:00+09:00','due_at':due},at);assert s==200,(s,review);cr=review['id']
def scope():return next(v for v in call('GET',path+'/company-reviews',token=at)[1]['items'] if v['id']==cr)
v=scope();s,response,_=call('PATCH',f'/admin/privacy/company-reviews/{cr}',{'request_revision':detail(rid)['revision'],'revision':v['revision'],'status':'in_review','identity':'confirmed','identity_evidence':'ROUND14 SYNTHETIC staff match','evidence_reference':'','internal_reason':'모의 자료 검증','public_message':'영수증 범위를 검토합니다.','due_at':due,'outcome':'','confirmed':False},at);assert s==200,(s,response)
rev=scope()['revision'];sourcepath=path+f'/receipt-sources/{cr}'
assert call('GET',sourcepath+f'?company_revision={rev}',token=token)[0]==403
s,sources,h=call('GET',sourcepath+f'?company_revision={rev}',token=at);assert s==200 and [x['id'] for x in sources['items']]==[receipt]
s,raw,h=call('POST',sourcepath+f'/{receipt}',{'company_revision':rev},at);assert s==200,(s,raw)
assert raw['sha256']==hashlib.sha256(source).hexdigest() and png_pixels(base64.b64decode(raw['data_base64']))==bytes([255,0,0,99,88,77])
b={'receipt':raw['receipt'],'company_review_id':cr,'company_revision':rev,'category':'receipt','source_reference':f'SYNTHETIC expense {expense} receipt {receipt}','source_sha256':raw['sha256'],'width':2,'height':1,'regions':[{'x':0,'y':0,'width':1,'height':1}],'notice':'모의 본인 영역만 포함하고 나머지는 제거했습니다.','rgb_base64':base64.b64encode(bytes([0,255,0,255,255,255])).decode()}
assert call('POST',path+'/image-preview',b,token)[0]==403
assert call('POST',path+'/images',{'revision':detail(rid)['revision'],'confirmed':True,'source_confirmed':True,'preview_sha256':'0'*64,**b},at)[0]==409
s,preview,h=call('POST',path+'/image-preview',b,at);assert s==200 and h['Cache-Control']=='no-store, private'
assert png_pixels(base64.b64decode(preview['png_base64']))==bytes([255,0,0,0,0,0])
s,d,_=call('POST',path+'/images',{'revision':detail(rid)['revision'],'confirmed':True,'source_confirmed':True,'preview_sha256':preview['preview_sha256'],**b},at);assert s==200,(s,d)
pid=d['id'];c['delivery_id']=pid;private.write_text(json.dumps(c))
assert detail(rid)['status']=='in_review'
public=call('GET',f'/privacy/requests/{rid}/images',token=token)[1];assert len(public['items'])==1
assert all(x not in json.dumps(public) for x in ['source_sha256','source_reference','regions','created_by','company_review_id'])
assert call('POST',f'/privacy/images/{pid}/download',{'password':c['password']},mint(other))[0]==404
assert call('POST',f'/privacy/images/{pid}/download',{'password':'wrong'},token)[0]==401
s,data,h=call('POST',f'/privacy/images/{pid}/download',{'password':c['password']},token);assert s==200 and png_pixels(data)==bytes([255,0,0,0,0,0])
assert data==base64.b64decode(preview['png_base64']) and h['Content-Type']=='application/octet-stream' and h['X-Content-Type-Options']=='nosniff' and 'attachment' in h['Content-Disposition']
assert guard()==c['baseline']
assert sql('SELECT content FROM fleet_expense_receipts WHERE id=%s',(receipt,)).tobytes()==source
sql("UPDATE fleet_expenses SET note='모의 수정 검증' WHERE id=%s AND owner_id=%s",(expense,owner))
assert call('POST',f'/privacy/images/{pid}/download',{'password':c['password']},token)[0]==409
assert sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s',(pid,))==0
assert sql('SELECT content FROM fleet_expense_receipts WHERE id=%s',(receipt,)).tobytes()==source
# Delete only this run's synthetic source after invalidation; immutable audit remains.
assert sql('SELECT email FROM users WHERE id=%s',(owner,)).startswith('account-smoke-')
sql('DELETE FROM fleet_expenses WHERE id=%s AND owner_id=%s',(expense,owner))
assert sql('SELECT count(*) FROM fleet_expense_receipts WHERE id=%s',(receipt,))==0
assert call('POST',f'/privacy/requests/{rid}/cancel',{'revision':detail(rid)['revision']},token)[0]==200
for subject in c['users']:
 s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'account_closure','scope':'라운드14 모의 검증 계정 이용 종료','password':c['password']},mint(subject));assert s==202
 assert call('POST',f"/admin/privacy/requests/{r['id']}/close-account",{'revision':r['revision']},at)[0]==200
 result=execute(worker,r['id']);assert not result['request_fulfilled']
assert all(sql('SELECT restricted FROM privacy_account_controls WHERE user_id=%s',(u,)) for u in c['users'])
assert guard()==c['baseline']
report={'release':health['release'],'schema':sql('SELECT max(version) FROM _sqlx_migrations'),'request_id':rid,'delivery_id':pid,'synthetic_account_ids':c['users'],'preview_gate':True,'password_and_foreign_account_denial':True,'excluded_pixels_removed_and_metadata_absent':True,'preview_and_download_exact_bytes':True,'no_automatic_whole_request_completion':True,'synthetic_accounts_closed':True,'real_accounts_and_sim_ownership_unchanged':True,'external_messages_sent':False,'full_erasure_confirmed':False,'company_source_scope_tested_on_production':True,'source_changed_delivery_purged':True,'forged_client_rgb_ignored':True,'synthetic_source_removed':True}
(p/'production-smoke.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
