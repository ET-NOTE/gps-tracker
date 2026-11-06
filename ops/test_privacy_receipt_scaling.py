"""No production mode: real API/DB workflow in an internal Docker network only.

Round 15: large stored receipts are reduced inside 2048px / one megapixel and turned upright
(JPEG EXIF) by the server; the selection, preview, delivery and invalidation all refer to the
same normalized pixels. Fixtures are synthetic and generated here.
"""
import base64,concurrent.futures,hashlib,json,os,pathlib,struct,subprocess,urllib.error,urllib.request,uuid,zlib
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
tag=uuid.uuid4().hex[:12];password='scaling-fixture-only-9!';passed=[]
def sql(q,args=()):
 with db.cursor() as c:
  c.execute(q,args);return c.fetchone()[0] if c.description else None
def call(method,path,body=None,token=None):
 h={'Content-Type':'application/json'}
 if token:h['Authorization']='Bearer '+token
 try:r=urllib.request.urlopen(urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers=h),timeout=60)
 except urllib.error.HTTPError as e:r=e
 with r:
  data=r.read();return r.status,json.loads(data) if 'application/json' in r.headers.get('content-type','') else data,r.headers
def check(s):passed.append(s);print('PASS '+s,flush=True)
def account(n):
 email=f'{tag}-{n}@example.invalid';phone='010'+str(int(tag,16)+n)[-8:]
 s,otp,_=call('POST','/auth/send-otp',{'phone':phone});assert s==200
 s,row,_=call('POST','/auth/register',{'email':email,'phone':phone,'otp_code':otp['dev_code'],'password':password,'display_name':'scaling fixture'});assert s==200,(s,row)
 return row
subject,company,other,admin=[account(n) for n in [51,52,53,54]]
oid=company['user_id'];token=subject['access_token'];at=admin['access_token'];ot=other['access_token']
sql("UPDATE users SET role='admin' WHERE id=%s",(admin['user_id'],))
def memory_peak():
 try:return int(subprocess.check_output(['docker','exec',API,'cat','/sys/fs/cgroup/memory.peak'],stderr=subprocess.DEVNULL))
 except Exception:return None
peak_before=memory_peak()
# Optional: keep real API responses for the screen review harness (synthetic sources only).
kept=os.environ.get('GPS_UI_FIXTURES')
def keep(name,value):
 if kept:pathlib.Path(kept,name).write_bytes(value if isinstance(value,bytes) else json.dumps(value).encode())

# ---- synthetic sources -------------------------------------------------------------------
SIG=b'\x89PNG\r\n\x1a\n'
def chunk(k,v):return struct.pack('>I',len(v))+k+v+struct.pack('>I',zlib.crc32(k+v)&0xffffffff)
def png_file(w,h,row,color=6,interlace=0,rows=None):
 """Rows are produced lazily so a large image never needs one big buffer here."""
 z=zlib.compressobj(6);packed=b''.join(z.compress(b'\0'+row(y)) for y in range(h if rows is None else rows))+z.flush()
 return SIG+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,color,0,0,interlace))+chunk(b'IDAT',packed)+chunk(b'IEND',b'')
DC=[(0b00,2),(0b010,3),(0b011,3),(0b100,3),(0b101,3),(0b110,3),(0b1110,4),(0b11110,5),(0b111110,6),(0b1111110,7),(0b11111110,8),(0b111111110,9)]
def jpeg_header(w,h,components=1,progressive=False,orientation=None):
 f=b'\xff\xd8'
 if orientation:
  t=b'Exif\0\0II*\0'+struct.pack('<IHHHIHHI',8,1,0x0112,3,1,orientation,0,0)
  f+=b'\xff\xe1'+struct.pack('>H',len(t)+2)+t
 f+=b'\xff\xdb\0\x43\0'+b'\x01'*64
 f+=(b'\xff\xc2' if progressive else b'\xff\xc0')+struct.pack('>HBHHB',8+3*components,8,h,w,components)+b''.join(bytes([c+1,0x11,0]) for c in range(components))
 f+=b'\xff\xc4\0\x1f\0'+bytes([0,1,5,1,1,1,1,1,1,0,0,0,0,0,0,0])+bytes(range(12))
 if not progressive:f+=b'\xff\xc4\0\x14\x10'+bytes([1]+[0]*15)+b'\0'
 return f+b'\xff\xda'+struct.pack('>HB',6+2*components,components)+b''.join(bytes([c+1,0]) for c in range(components))+bytes([0,0 if progressive else 63,0])
def jpeg_file(w,h,block,components=1,progressive=False,orientation=None):
 """Minimal JPEG whose 8x8 blocks are flat: DC coefficients only, unit quantization."""
 parts=[];prev=[0]*components;memo={}
 for by in range((h+7)//8):
  for bx in range((w+7)//8):
   v=block(bx,by)
   for c in range(components):
    dc=8*(v[c]-128);d=dc-prev[c];prev[c]=dc
    if d not in memo:
     cat=abs(d).bit_length();code,n=DC[cat]
     memo[d]=format(code,f'0{n}b')+(format(d if d>=0 else d+(1<<cat)-1,f'0{cat}b') if cat else '')+('' if progressive else '0')
    parts.append(memo[d])
 bits=''.join(parts);bits+='1'*(-len(bits)%8)
 return jpeg_header(w,h,components,progressive,orientation)+int(bits,2).to_bytes(len(bits)//8,'big').replace(b'\xff',b'\xff\0')+b'\xff\xd9'
def png_image(data):
 assert data[:8]==SIG;i=8;kinds=[];packed=b''
 while i<len(data):
  n=struct.unpack('>I',data[i:i+4])[0];kind=data[i+4:i+8];v=data[i+8:i+8+n];kinds.append(kind)
  if kind==b'IHDR':w,h,depth,color,_,_,_=struct.unpack('>IIBBBBB',v);assert depth==8 and color==2
  if kind==b'IDAT':packed+=v
  i+=n+12
 assert set(kinds)=={b'IHDR',b'IDAT',b'IEND'},kinds
 raw=zlib.decompress(packed);stride=w*3;rows=[];prev=bytes(stride);assert len(raw)==h*(stride+1)
 for y in range(h):
  f=raw[y*(stride+1)];line=raw[y*(stride+1)+1:(y+1)*(stride+1)]
  if f==0:row=line
  elif f==2:row=bytes((a+b)&255 for a,b in zip(line,prev))
  else:
   row=bytearray(line)
   for x in range(stride):
    a=row[x-3] if x>=3 else 0;b=prev[x];c=prev[x-3] if x>=3 else 0
    p=a+b-c;pa,pb,pc=abs(p-a),abs(p-b),abs(p-c);v=a if pa<=pb and pa<=pc else b if pb<=pc else c
    row[x]=(row[x]+[0,a,b,(a+b)//2,v][f])%256
   row=bytes(row)
  rows.append(row);prev=row
 return w,h,rows
def px(img,x,y):return tuple(img[2][y][x*3:x*3+3])
def near(a,b,t=1):return all(abs(p-q)<=t for p,q in zip(a,b))
def gray(v):return (v,v,v)
quad=lambda bx,by:[[10,80][bx>=250] if by<188 else [160,240][bx>=250]]   # 4000x3000 -> 500x375 blocks
sha=lambda b:hashlib.sha256(b).hexdigest()

# ---- scope: confirmed company/staff/date review ------------------------------------------
due=(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()
s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'access','scope':'Scaled receipt fixture','password':password},token);assert s==202,(s,r)
s,r,_=call('PATCH',f"/admin/privacy/requests/{r['id']}",{'revision':r['revision'],'status':'in_review','message':'Review scope','evidence_reference':'SYNTHETIC','due_at':due},at);assert s==200,(s,r)
rid=r['id'];path=f'/admin/privacy/requests/{rid}'
def revision():return call('GET',path,token=at)[1]['request']['revision']
staff=sql("INSERT INTO staff(user_id,name,access_role) VALUES(%s,'Scaling fixture','member') RETURNING id",(oid,))
category=sql("SELECT id FROM fleet_expense_categories WHERE owner_id=%s AND kind='expense' ORDER BY id LIMIT 1",(oid,))
def expense():
 return sql("INSERT INTO fleet_expenses(owner_id,created_by,request_id,request_value,spent_on,category_id,category_name,group_name,category_kind,staff_id,staff_name,department_name,vehicle_name,amount_krw,payment_method,status) VALUES(%s,%s,%s,'{}','2026-01-01',%s,'Fuel fixture','Test','expense',%s,'Hidden name','Hidden department','',1000,'cash','pending') RETURNING id",(oid,oid,str(uuid.uuid4()),category,staff))
def attach(content,mime='image/jpeg'):
 e=expense();return e,sql("INSERT INTO fleet_expense_receipts(owner_id,expense_id,filename,mime,content,digest) VALUES(%s,%s,'PRIVATE_FILENAME',%s,%s,%s) RETURNING id",(oid,e,mime,content,sha(content)))
s,c,_=call('POST',path+'/company-reviews',{'revision':revision(),'company_owner_id':oid,'staff_id':staff,'category':'expenses','from_at':'2026-01-01T00:00:00+09:00','until_at':'2026-01-02T00:00:00+09:00','due_at':due},at);assert s==200,(s,c);cr=c['id']
def company_state():return next(x for x in call('GET',path+'/company-reviews',token=at)[1]['items'] if x['id']==cr)
c=company_state();s,v,_=call('PATCH',f'/admin/privacy/company-reviews/{cr}',{'request_revision':revision(),'revision':c['revision'],'status':'in_review','identity':'confirmed','identity_evidence':'SYNTHETIC staff match','evidence_reference':'','internal_reason':'fixture','public_message':'Reviewing','due_at':due,'outcome':'','confirmed':False},at);assert s==200,(s,v)
def read(fid,who=at):
 sql('DELETE FROM privacy_result_limits');return call('POST',path+f'/receipt-sources/{cr}/{fid}',{'company_revision':company_state()['revision']},who)
def preview(b):
 sql('DELETE FROM privacy_result_limits');return call('POST',path+'/image-preview',b,at)
def issue(b):
 s,p,_=preview(b);assert s==200,(s,p)
 s,d,_=call('POST',path+'/images',{'revision':revision(),'confirmed':True,'source_confirmed':True,'preview_sha256':p['preview_sha256'],**b},at);return s,d,p
def download(did,who=token):
 sql('DELETE FROM privacy_result_limits');return call('POST',f'/privacy/images/{did}/download',{'password':password},who)
def selection(raw,regions,content):
 n=raw['normalization']
 # The browser's pixels are deliberately garbage: a server-bound source must ignore them.
 return {'receipt':raw['receipt'],'company_review_id':cr,'company_revision':company_state()['revision'],'category':'receipt','source_reference':'SYNTHETIC scaled','source_sha256':sha(content),'width':n['width'],'height':n['height'],'regions':regions,'notice':'Only the subject area; the rest is removed.','rgb_base64':'AAAA'}
def proofs(fid):return sql('SELECT count(*) FROM privacy_receipt_reads WHERE receipt_id=%s',(fid,))

# ---- 1. large baseline JPEG ---------------------------------------------------------------
big=jpeg_file(4000,3000,quad);assert len(big)<5*1024*1024
e,f=attach(big);s,raw,h=read(f);assert s==200,(s,raw)
assert raw['normalization']=={'version':2,'source_width':4000,'source_height':3000,'width':1154,'height':865,'orientation':1,'reduced':True},raw['normalization']
display=base64.b64decode(raw['data_base64']);assert raw['display_sha256']==sha(display) and raw['sha256']==sha(big) and raw['mime']=='image/png' and h['Cache-Control']=='no-store, private'
img=png_image(display);assert img[:2]==(1154,865)
assert near(px(img,100,100),gray(10)) and near(px(img,1000,100),gray(80)) and near(px(img,100,800),gray(160)) and near(px(img,1000,800),gray(240))
proof=sql('SELECT pixels_sha256 FROM privacy_receipt_reads WHERE receipt_id=%s',(f,));assert len(proof)==64
assert sql("SELECT normalization FROM privacy_receipt_reads WHERE receipt_id=%s",(f,))==raw['normalization']
s,again,_=read(f);assert s==200 and again['display_sha256']==raw['display_sha256']
assert sql('SELECT count(DISTINCT pixels_sha256) FROM privacy_receipt_reads WHERE receipt_id=%s',(f,))==1
assert sql('SELECT content FROM fleet_expense_receipts WHERE id=%s',(f,)).tobytes()==big
keep('source-upright.jpg',big);keep('read-upright.json',raw)
check('4000x3000 JPEG reduced to 1154x865 inside limits; deterministic pixels; read proof records pixel hash and transform; original bytes unchanged')

regions=[{'x':50,'y':50,'width':100,'height':100},{'x':1000,'y':800,'width':100,'height':50}]
b=selection(raw,regions,big);s,p,_=preview(b);assert s==200,(s,p)
out=png_image(base64.b64decode(p['png_base64']));assert out[:2]==(1154,865)
assert near(px(out,60,60),gray(10)) and near(px(out,1050,820),gray(240))
for x,y in [(0,0),(49,60),(150,60),(60,150),(600,400),(999,820),(1050,799),(1050,850),(1153,864)]:assert px(out,x,y)==(0,0,0),(x,y)
assert preview({**b,'width':4000,'height':3000})[0]==400 and preview({**b,'width':865,'height':1154})[0]==400
assert preview({**b,'regions':[{'x':1100,'y':800,'width':100,'height':50}]})[0]==400
s,d,p=issue(b);assert s==200,(s,d);did=d['id']
s,body,_=download(did);assert s==200 and body==base64.b64decode(p['png_base64'])
assert download(did,ot)[0]==404
assert sql('SELECT source_normalization FROM privacy_image_deliveries WHERE id=%s',(did,))==raw['normalization']
listed=json.dumps(call('GET',f'/privacy/requests/{rid}/images',token=token)[1])
assert not any(k in listed for k in ['normalization','source_width','receipt_id','source_sha256','pixels'])
keep('preview-upright.json',{'request':b,'response':p})
check('selection uses reduced coordinates; forged browser pixels ignored; unselected area black; source-size or rotated-size selections rejected; delivery equals preview; requester sees no source metadata')

# ---- 2. EXIF orientation -------------------------------------------------------------------
turned=jpeg_file(4000,3000,quad,orientation=6);_,ft=attach(turned);s,rt,_=read(ft);assert s==200,(s,rt)
assert rt['normalization']=={'version':2,'source_width':4000,'source_height':3000,'width':865,'height':1154,'orientation':6,'reduced':True}
img=png_image(base64.b64decode(rt['data_base64']));assert img[:2]==(865,1154)
assert near(px(img,100,100),gray(160)) and near(px(img,800,100),gray(10)) and near(px(img,100,1000),gray(240)) and near(px(img,800,1000),gray(80))
assert sql('SELECT pixels_sha256 FROM privacy_receipt_reads WHERE receipt_id=%s',(ft,))!=proof
bt=selection(rt,[{'x':700,'y':50,'width':100,'height':100}],turned);s,d,p=issue(bt);assert s==200,(s,d)
out=png_image(base64.b64decode(p['png_base64']));assert out[:2]==(865,1154) and near(px(out,750,100),gray(10)) and px(out,100,100)==(0,0,0)
small=jpeg_file(16,8,lambda bx,by:[[40,200][bx]],orientation=3);_,fs=attach(small);s,rs,_=read(fs);assert s==200,(s,rs)
assert rs['normalization']=={'version':2,'source_width':16,'source_height':8,'width':16,'height':8,'orientation':3,'reduced':False}
img=png_image(base64.b64decode(rs['data_base64']));assert near(px(img,0,0),gray(200)) and near(px(img,15,7),gray(40))
keep('source-turned.jpg',turned);keep('read-turned.json',rt)
check('EXIF orientation 6 turns the reduced image upright (865x1154) with matching coordinates; orientation 3 applies to small sources; pixel proof differs from the unrotated image')

# ---- 3. a read proof must cover the same normalized pixels -----------------------------------
plain=jpeg_file(16,8,lambda bx,by:[[40,200][bx]]);_,fp=attach(plain)
rr,er=sql('SELECT privacy_revision FROM fleet_expense_receipts WHERE id=%s',(fp,)),sql('SELECT e.privacy_revision FROM fleet_expenses e JOIN fleet_expense_receipts f ON f.expense_id=e.id WHERE f.id=%s',(fp,))
bp={'receipt':{'id':fp,'receipt_revision':rr,'expense_revision':er},'company_review_id':cr,'company_revision':company_state()['revision'],'category':'receipt','source_reference':'SYNTHETIC proof','source_sha256':sha(plain),'width':16,'height':8,'regions':[{'x':0,'y':0,'width':4,'height':4}],'notice':'Only the subject area.','rgb_base64':'AAAA'}
assert preview(bp)[0]==409
legacy="INSERT INTO privacy_receipt_reads(request_id,review_id,review_revision,actor_id,receipt_id,receipt_revision,expense_revision,sha256,pixels_sha256) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)"
args=(rid,cr,bp['company_revision'],admin['user_id'],fp,rr,er,sha(plain))
sql(legacy,args+(None,));assert preview(bp)[0]==409          # proof from before pixel binding
sql(legacy,args+('0'*64,));assert preview(bp)[0]==409        # proof of different pixels
s,rp,_=read(fp);assert s==200;s,p,_=preview(bp);assert s==200,(s,p)
assert near(px(png_image(base64.b64decode(p['png_base64'])),1,1),gray(40))
check('a read proof without, or with different, normalized pixels cannot authorize a selection; a fresh read does')

# ---- 4. limits apply before decoding ----------------------------------------------------------
def refused(content,mime,word=None):
 _,fid=attach(content,mime);s,v,_=read(fid);assert s==400,(s,v);assert proofs(fid)==0
 if word:assert word in v['error'],v
refused(jpeg_header(65535,65535)+b'\xff\xd9','image/jpeg','한도')
refused(jpeg_header(9000,8000)+b'\xff\xd9','image/jpeg','한도')
refused(jpeg_header(4000,3000,progressive=True)+b'\xff\xd9','image/jpeg','한도')
refused(jpeg_header(8,8,components=4)+b'\xff\xd9','image/jpeg')
refused(png_file(16385,1,lambda y:b'',rows=0),'image/png','한도')
refused(png_file(6000,5000,lambda y:b'',rows=0),'image/png','한도')
refused(png_file(3000,2000,lambda y:b'',interlace=1,rows=0),'image/png','한도')
refused(png_file(3000,2000,lambda y:bytes(3000*4),rows=1000),'image/png')   # truncated rows
refused(b'\xff\xd8\xff\xe0garbage','image/jpeg')
check('oversized declared sizes, large progressive/interlaced, CMYK and truncated sources are refused with no read proof')

# ---- 5. accepted large variants -----------------------------------------------------------------
row=bytes([255,0,0,255])*1050+bytes([9,8,7,0])*1050
wide=png_file(2100,1000,lambda y:row);_,fw=attach(wide,'image/png');s,rw,_=read(fw);assert s==200,(s,rw)
assert rw['normalization']=={'version':2,'source_width':2100,'source_height':1000,'width':1449,'height':690,'orientation':1,'reduced':True}
img=png_image(base64.b64decode(rw['data_base64']));assert px(img,10,10)==(255,0,0) and px(img,1439,680)==(255,255,255)
color=jpeg_file(2400,1600,lambda bx,by:[128,128,255] if bx<150 else [128,128,128],components=3);_,fc=attach(color);s,rc,_=read(fc);assert s==200,(s,rc)
img=png_image(base64.b64decode(rc['data_base64']));assert img[:2]==(1225,816) and near(px(img,100,400),(255,37,128),3) and near(px(img,1100,400),gray(128),3)
prog=jpeg_file(3264,2448,lambda bx,by:[90,128,128],components=3,progressive=True);_,fg=attach(prog);s,rg,_=read(fg);assert s==200,(s,rg)
assert rg['normalization']['reduced'] and near(px(png_image(base64.b64decode(rg['data_base64'])),500,400),gray(90),2)
huge=jpeg_file(8000,8000,lambda bx,by:[[30,220][(bx+by)%2]]);assert len(huge)<5*1024*1024;_,fh=attach(huge);s,rh,_=read(fh);assert s==200,(s,rh)
assert rh['normalization']=={'version':2,'source_width':8000,'source_height':8000,'width':1000,'height':1000,'orientation':1,'reduced':True}
img=png_image(base64.b64decode(rh['data_base64']));assert near(px(img,0,0),gray(30)) and near(px(img,1,0),gray(220)) and near(px(img,1,1),gray(30))
peak_after=memory_peak();assert peak_after is None or peak_after<400*1024*1024,peak_after
check('row-streamed RGBA PNG, full-scale colour JPEG, bounded progressive JPEG and a 64MP JPEG all normalize; container memory stays bounded')

# ---- 6. source changes invalidate reduced deliveries ----------------------------------------------
s,raw,_=read(f);b=selection(raw,regions,big);s,d,_=issue(b);assert s==200,(s,d);did=d['id'];assert download(did)[0]==200
sql("UPDATE fleet_expenses SET note='edited' WHERE id=%s",(e,))
assert download(did)[0]==409 and sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s',(did,))==0 and preview(b)[0]==409
s,raw,_=read(f);b=selection(raw,regions,big);s,d,_=issue(b);assert s==200,(s,d);did=d['id']
sql('UPDATE fleet_expense_receipts SET content=%s,digest=%s WHERE id=%s',(turned,sha(turned),f))
assert download(did)[0]==409 and sql('SELECT count(*) FROM privacy_image_payloads WHERE delivery_id=%s',(did,))==0 and preview(b)[0]==409
s,raw,_=read(f);assert s==200 and raw['normalization']['orientation']==6 and (raw['normalization']['width'],raw['normalization']['height'])==(865,1154)
assert preview(selection(raw,regions,big))[0]==409     # old hash with the new source
assert preview({**selection(raw,[{'x':0,'y':0,'width':10,'height':10}],turned)})[0]==200
sql('UPDATE fleet_expense_receipts SET removed_at=now() WHERE id=%s',(f,));assert read(f)[0]==409
check('expense edits, replaced bytes and removal block reduced deliveries and purge derived PNGs; a replaced source needs a new read and selection')

# ---- 7. concurrent large reads are refused, not queued without bound ---------------------------------
sql('DELETE FROM privacy_result_limits');revision_now=company_state()['revision']
def raced(fid):return call('POST',path+f'/receipt-sources/{cr}/{fid}',{'company_revision':revision_now},at)[0]
with concurrent.futures.ThreadPoolExecutor(6) as pool:statuses=list(pool.map(raced,[fh,ft,fc,fg,fh,ft]))
assert set(statuses)<={200,429} and 200 in statuses,statuses
assert read(fh)[0]==200
check('simultaneous large reductions answer 200 or 429 only and recover immediately')

# ---- 8. nothing temporary is left behind (other suites assert an empty payload table) -----------------
for d in call('GET',path+'/images',token=at)[1]['items']:
 if not d['revoked_at']:assert call('POST',f"/admin/privacy/images/{d['id']}/revoke",{},at)[0]==200
assert sql('SELECT count(*) FROM privacy_image_payloads p JOIN privacy_image_deliveries g ON g.id=p.delivery_id WHERE g.request_id=%s',(rid,))==0
assert sql('SELECT count(*) FROM privacy_image_deliveries WHERE request_id=%s AND source_normalization IS NOT NULL',(rid,))==4
check('revoking the remaining reduced deliveries removes every temporary PNG; the transform record stays with the delivery metadata')

report={'integration_groups':len(passed),'groups':passed,'api_sha256':digest,'schema':sql('SELECT max(version) FROM _sqlx_migrations'),'concurrent_statuses':statuses,'memory_peak_before':peak_before,'memory_peak_after':peak_after}
assert report['schema']==97,report['schema']
(pathlib.Path(__file__).parent/'receipt-scaling-validation.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
