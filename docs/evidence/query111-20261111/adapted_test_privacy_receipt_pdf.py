"""No production mode: real API/DB workflow in an internal Docker network only.

Round 16: a stored PDF receipt is drawn one page at a time by the isolated renderer
(gps-pdf-render). Selection, preview, delivery and invalidation refer to the page's pixels as
the server produced them from the stored original. Fixtures are synthetic and generated here;
the two encrypted ones were made with qpdf from the same two-page document.
"""
import base64,concurrent.futures,hashlib,json,os,pathlib,struct,subprocess,time,urllib.error,urllib.request,uuid,zlib
from datetime import datetime,timedelta,timezone
import psycopg as psycopg2

NETWORK='gps-provision22-test-20261111cumulative111';DB='gps-provision22-db-20261111cumulative111';API='gps-provision22-api-20261111cumulative111'
inspect=lambda kind,name:json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NETWORK)['Internal']
di,ai=inspect('container',DB),inspect('container',API)
cfg=dict(v.split('=',1) for v in ai['Config']['Env'] if '=' in v)
assert cfg['APP_ENV']=='test' and urllib.parse.urlparse(cfg['DATABASE_URL']).username=='gps_runtime' and urllib.parse.urlparse(cfg['DATABASE_URL']).hostname in ('closure-db',di['NetworkSettings']['Networks'][NETWORK]['IPAddress']) and urllib.parse.urlparse(cfg['DATABASE_URL']).path=='/gps_closure_test'
binary=pathlib.Path(__file__).parent/'out/gps-tracker-api';digest=hashlib.sha256(binary.read_bytes()).hexdigest()
assert subprocess.check_output(['docker','exec',API,'sha256sum','/proc/1/exe']).decode().split()[0]==digest
renderer=hashlib.sha256((pathlib.Path(__file__).parent/'out/gps-pdf-render').read_bytes()).hexdigest()
assert subprocess.check_output(['docker','exec',API,'sha256sum','/gps-pdf-render']).decode().split()[0]==renderer
base=f"http://{ai['NetworkSettings']['Networks'][NETWORK]['IPAddress']}:3043/gps-tracker/api/v1"
db=psycopg2.connect(f"postgres://postgres:closure-test-only@{di['NetworkSettings']['Networks'][NETWORK]['IPAddress']}/gps_closure_test");db.autocommit=True;db.execute("SELECT set_config('gps.storage_keys',%s,false)",(pathlib.Path(__file__).with_name('test-keys.json').read_text(),))
tag=uuid.uuid4().hex[:12];password='pdf-fixture-only-9!';passed=[]
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
 s,row,_=call('POST','/auth/register',{'email':email,'phone':phone,'otp_code':otp['dev_code'],'password':password,'display_name':'pdf fixture'});assert s==200,(s,row)
 return row
subject,company,other,admin=[account(n) for n in [61,62,63,64]]
oid=company['user_id'];token=subject['access_token'];at=admin['access_token'];ot=other['access_token']
sql("UPDATE users SET role='admin' WHERE id=%s",(admin['user_id'],))
# Optional: keep real API responses for the screen review harness (synthetic sources only).
kept=os.environ.get('GPS_UI_FIXTURES')
def keep(name,value):
 if kept:pathlib.Path(kept,name).write_text(json.dumps(value))

# ---- synthetic documents ----------------------------------------------------------------------
SIG=b'\x89PNG\r\n\x1a\n'
def pdf(objects):
 data=b'%PDF-1.5\n';offsets=[]
 for number,body in enumerate(objects,1):
  offsets.append(len(data));data+=f'{number} 0 obj\n'.encode()+(body if isinstance(body,bytes) else body.encode())+b'\nendobj\n'
 xref=len(data)
 data+=f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode()+b''.join(f'{o:010} 00000 n \n'.encode() for o in offsets)
 return data+f'trailer\n<</Size {len(objects)+1}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n'.encode()
def stream(content,dictionary=''):
 content=content if isinstance(content,bytes) else content.encode()
 return f'<</Length {len(content)}{dictionary}>>\nstream\n'.encode()+content+b'\nendstream'
def document(first='1 0 0 rg 0 0 100 100 re f',second='0 0 1 rg 60 60 90 90 re f'):
 """Page 1: 200x100pt, left half red. Page 2: 300x300pt, a blue square at 60..150pt from the bottom left."""
 return pdf(['<</Type/Catalog/Pages 2 0 R>>','<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>','<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>',stream(first),'<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents 6 0 R>>',stream(second)])
def blank(pages,box='[0 0 200 200]'):
 kids=' '.join(f'{3+i} 0 R' for i in range(pages))
 return pdf(['<</Type/Catalog/Pages 2 0 R>>',f'<</Type/Pages/Kids[{kids}]/Count {pages}>>']+[f'<</Type/Page/Parent 2 0 R/MediaBox{box}>>']*pages)
def bomb(side=30000):
 """A tiny stream that expands to 900 megapixels."""
 return pdf(['<</Type/Catalog/Pages 2 0 R>>','<</Type/Pages/Kids[3 0 R]/Count 1>>','<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</XObject<</Im1 5 0 R>>>>/Contents 4 0 R>>',stream('q 595 0 0 842 0 0 cm /Im1 Do Q'),
  stream(zlib.compress(bytes(side*side//8),9),f'/Type/XObject/Subtype/Image/Width {side}/Height {side}/ColorSpace/DeviceGray/BitsPerComponent 1/Filter/FlateDecode')])
def padded(total=5*1024*1024):
 """The two-page document at exactly the largest size a stored receipt may have."""
 def build(n):return pdf(['<</Type/Catalog/Pages 2 0 R>>','<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>','<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>',stream('1 0 0 rg 0 0 100 100 re f'),'<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents 6 0 R>>',stream('0 0 1 rg 60 60 90 90 re f'),stream(bytes(n))])
 n=total-len(build(0));data=build(n)
 while len(data)!=total:n-=len(data)-total;data=build(n)
 return data
ENCRYPTED_USER=zlib.decompress(base64.b64decode('eNqdVE2IHEUUFjw5XrwYPIWSsAeFpOu/umDZkM3MgLph465ZDyGHV1WvNyOzPUtPJ+wa8KTiRb0IIYgH/1AjHvQUT3sURVAPIigSBD14MHoyghB93bs7O2ECEfunquv9fN+rV+/13Olu/6g45jpzOzffutURjLNReKYzP8+y3laN5XgwKsesWZ7oLvbaj0UY4xpWjYZl5DpluYQXcchytrDQPNlpWMcxk4S5wrKntjeRZSehhuFondQdLFNDJacoT44ulDU5ZE8M0pidZap11e14bh9iF/UAQN0GUFIo9ZiZXdJTmAawONoiLE635JwJes81KBW2XFPBNchTwPpOwPaOwIrvvv8N2EwBL2G5Xp9nOmdZfzCssaJ5CDV2MY5S6zSuK4SNzgd//vj2izfrVz586MahP248yO45fGX773uv/vPA8fuee/jJKx+998Xla+98/cZv310/fv/Lzz+aiGvPc4/V/h/WTx959fXvPzt868vfr/6Si8d//enSkR9+3vn2q8tvPn1o+O5L37xwxOxc//iv9z/5/Ng1uPTa0gyrm05ivy2g1TrtfZ24UJ/vXWzSlXVHcXkTy8boFCl6q2tqEqaS+xW1H+xqDWWCKk1MpLEsW2bzXClnhEGhIFrpIeUSnInowYpCmKgwqcADqhi0tEhnFr0OXhSFsUXBfYHWWKNASOFBeC4cOiEsJ5V21kuKYZnaIAj0PBgro49OQ0g6GovBKakKkDJyz0FJRDDcORUtGJWM9Rx5TIKMmuZgRzWNWG1Qf2kANFrnLikCS0WRgwvcgEpOC+8s2a9Q6dG+N/r7CaSpOlicIRAsAkBuoNAGTBKcMCXoYASPBqRRxhTEYkE47TwgKB6KoIKSIWoVHeYSiS/Pc4GoaDue57lFhxxlVC5QEGdo70rQrhWl0frYpCwmVzhTBJ4KDsknB4XlIfIQokkJXB5kyK0hrECnoIFg1qg/D9phq8Kiw1ne4ZOLWUPhsoJNZIKaptWUE5lQfFbmZ+1krmdkyqkZmfZiRma5P5DVFQyGVH5N6a6MRjUTu02+OngW6a+XPdZlZ+d1QhWco3LTLjeFUM5RHdLRROtACb9wdwv6i/TKWG1v1sy1DG0/QlW3mRLC2M7cXG+53/kXCoCovQ=='))
ENCRYPTED_OWNER_ONLY=zlib.decompress(base64.b64decode('eNqdVM2LHEUUF0SURgISPOQidRkQ4qbr+wOGhezODJEkbNxJNoeYQ3282kwy2732dMImlxw2GPIHeBIPJp4kp4hnD7l4iRdBCJhDEPSgePEjLIJY3bs7O2ECit1dVf1evff7vX79XnXO9AYL5JjKOl89u/t3RhBGpbucdbso72/VUExGZTFBjXi8t9RvX5bsBNaganZQnlxnLE/BNRgjjRYXmyc/Y9dhgmjCXEX52eubgPJlW9txuZ62MyhCQ0VnKJfLq0WdHPKTozBBFxBrXXk7X9yH2EU9AGDPARQplHqCxC7paQgju1RuJSycbooxImlcbFAqaLlmgmuQZ4D5i4DlC4EZ3h3/DVjMAJ+CYr2+hLhG+WA0rqFK69jW0ANfhtZpUldgN7Lz72z+/sWzp0feW1t+5dann736x1v+xJX3jz5++/zNbz7889CPO1/+9cl3L6M793c+7zz++udvE9ee5x6r/D+sj24sfPBoePje9scP9OsfPXxt8v1LP+BbT4rtI9u//PTGxrE7aHvh4W83D99+cuLszq9P35xjVbNJHLQFNKzD3tvxq/Wl/rUmXXmv9CubUDRGp9NGf7jGpmEyul9R+8EOa1sEW4WpCRUS5SuoG62gkTJNsFRBeMG8YURa0EmOTnsTsCSWMkfBcaYiJ8KBV8YZGqNwKglY4Cii84pJbonXICT2ykdhpJEphpXUBkQbDzI5SxuC9VZp5SkDZigGbJk2jCmDBaNWeEmdt9JjFY1h4CEYYpvmQAs8zVBtpP7SkVCPLQ6U2ig5tsRqR2wEzXXCoMl+NZVe+u6NwX4C01IdCOdQFzwL3lopA9XYRS0okV4ANxFHJ70HAtF7wT2A11gHFykIJziL3DPpNI+GxOB4bFKRRtCgIBrquNPWuiaIc/0mVmuFiiBTEogy1lLBOTcqqoixCVJxQmmCFVFKIwylmFBuMPc4AubRJZi11J8H7bBVQcww0hmeXkgKwQSKaKojqWnanWKqIwzP68y8HdV8TscUm9NxQ+Z0EpsDXV3Z0TiVX1O6q2VZI7Lb5MPRDUinXv5uD13okhCCMKm+lMI+GCMFSX/fSy0cVylRi/9ukU6RfuGr65s1Ui1D24+2qttMkVR1WafTXxlk/wBhwKUD'))
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
sha=lambda b:hashlib.sha256(b).hexdigest()
RED,BLUE,WHITE,BLACK=(255,0,0),(0,0,255),(255,255,255),(0,0,0)

# ---- scope: confirmed company/staff/date review -------------------------------------------------
due=(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()
s,r,_=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'access','scope':'PDF receipt fixture','password':password},token);assert s==202,(s,r)
s,r,_=call('PATCH',f"/admin/privacy/requests/{r['id']}",{'revision':r['revision'],'status':'in_review','message':'Review scope','evidence_reference':'SYNTHETIC','due_at':due},at);assert s==200,(s,r)
rid=r['id'];path=f'/admin/privacy/requests/{rid}'
def revision():return call('GET',path,token=at)[1]['request']['revision']
staff=sql("INSERT INTO staff(user_id,name,access_role) VALUES(%s,'PDF fixture','member') RETURNING id",(oid,))
category=sql("SELECT id FROM fleet_expense_categories WHERE owner_id=%s AND kind='expense' ORDER BY id LIMIT 1",(oid,))
def expense():
 return sql("INSERT INTO fleet_expenses(owner_id,created_by,request_id,request_value,spent_on,category_id,category_name,group_name,category_kind,staff_id,staff_name,department_name,vehicle_name,amount_krw,payment_method,status) VALUES(%s,%s,%s,'{}','2026-01-01',%s,'Insurance fixture','Test','expense',%s,'Hidden name','Hidden department','',1000,'cash','pending') RETURNING id",(oid,oid,str(uuid.uuid4()),category,staff))
def attach(content,mime='application/pdf'):
 e=expense();return e,sql("INSERT INTO fleet_expense_receipts(owner_id,expense_id,filename,mime,content,digest) VALUES(%s,%s,'PRIVATE_FILENAME',%s,%s,%s) RETURNING id",(oid,e,mime,content,sha(content)))
s,c,_=call('POST',path+'/company-reviews',{'revision':revision(),'company_owner_id':oid,'staff_id':staff,'category':'expenses','from_at':'2026-01-01T00:00:00+09:00','until_at':'2026-01-02T00:00:00+09:00','due_at':due},at);assert s==200,(s,c);cr=c['id']
def company_state():return next(x for x in call('GET',path+'/company-reviews',token=at)[1]['items'] if x['id']==cr)
c=company_state();s,v,_=call('PATCH',f'/admin/privacy/company-reviews/{cr}',{'request_revision':revision(),'revision':c['revision'],'status':'in_review','identity':'confirmed','identity_evidence':'SYNTHETIC staff match','evidence_reference':'','internal_reason':'fixture','public_message':'Reviewing','due_at':due,'outcome':'','confirmed':False},at);assert s==200,(s,v)
def listing(who=at):return call('GET',path+f'/receipt-sources/{cr}?company_revision={company_state()["revision"]}',token=who)
def read(fid,page=None,who=at):
 sql('DELETE FROM privacy_result_limits');body={'company_revision':company_state()['revision']}
 if page is not None:body['page']=page
 return call('POST',path+f'/receipt-sources/{cr}/{fid}',body,who)
def preview(b):
 sql('DELETE FROM privacy_result_limits');return call('POST',path+'/image-preview',b,at)
def issue(b):
 s,p,_=preview(b);assert s==200,(s,p)
 s,d,_=call('POST',path+'/images',{'revision':revision(),'confirmed':True,'source_confirmed':True,'preview_sha256':p['preview_sha256'],**b},at);return s,d,p
def download(did,who=token,pwd=password):
 sql('DELETE FROM privacy_result_limits');return call('POST',f'/privacy/images/{did}/download',{'password':pwd},who)
def selection(raw,regions,content):
 n=raw['normalization']
 # The browser's pixels are deliberately garbage: a server-bound source must ignore them.
 return {'receipt':raw['receipt'],'company_review_id':cr,'company_revision':company_state()['revision'],'category':'receipt','source_reference':f"SYNTHETIC page {n.get('page')}",'source_sha256':sha(content),'width':n['width'],'height':n['height'],'regions':regions,'notice':'Only the subject area; the rest is removed.','rgb_base64':'AAAA'}
def proofs(fid):return sql('SELECT count(*) FROM privacy_receipt_reads WHERE receipt_id=%s',(fid,))
def payloads(did):return sql('SELECT count(*) FROM gps_read_privacy_image_payloads WHERE delivery_id=%s',(did,))

# ---- 1. a PDF opens page by page, drawn by the server from the stored original ----------------------
doc=document();e,f=attach(doc)
assert listing(token)[0]==403 and read(f,who=token)[0]==403
s,items,_=listing();assert s==200 and [(v['id'],v['mime']) for v in items['items']]==[(f,'application/pdf')],(s,items)
assert not any(x in json.dumps(items) for x in ['PRIVATE_FILENAME','Hidden name','content','digest'])
s,one,h=read(f);assert s==200,(s,one)
n=one['normalization'];assert n=={'version':3,'kind':'pdf','page':1,'pages':2,'page_width_pt':200.0,'page_height_pt':100.0,'width':1414,'height':707,'renderer_sha256':renderer},n
assert one['receipt']=={'id':f,'receipt_revision':1,'expense_revision':1,'page':1} and one['sha256']==sha(doc) and one['mime']=='image/png' and h['Cache-Control']=='no-store, private'
shown=base64.b64decode(one['data_base64']);assert one['display_sha256']==sha(shown)
img=png_image(shown);assert img[:2]==(1414,707) and px(img,100,100)==RED and px(img,700,350)==RED and px(img,714,350)==WHITE and px(img,1300,100)==WHITE
assert sql('SELECT page FROM privacy_receipt_reads WHERE receipt_id=%s',(f,))==1 and len(sql('SELECT pixels_sha256 FROM privacy_receipt_reads WHERE receipt_id=%s',(f,)))==64
assert sql('SELECT normalization FROM privacy_receipt_reads WHERE receipt_id=%s',(f,))==n
s,two,_=read(f,2);assert s==200,(s,two)
assert two['normalization']=={**n,'page':2,'page_width_pt':300.0,'page_height_pt':300.0,'width':1000,'height':1000} and two['receipt']['page']==2
img=png_image(base64.b64decode(two['data_base64']));assert img[:2]==(1000,1000) and px(img,350,650)==BLUE and px(img,100,100)==WHITE and px(img,350,400)==WHITE
assert sql('SELECT count(DISTINCT pixels_sha256) FROM privacy_receipt_reads WHERE receipt_id=%s',(f,))==2
s,again,_=read(f,2);assert s==200 and again['display_sha256']==two['display_sha256']
for page in (0,3,201):
 s,v,_=read(f,page);assert s==400 and '쪽' in v['error'],(page,s,v)
assert proofs(f)==3 and sql('SELECT content FROM gps_read_fleet_expense_receipts WHERE id=%s',(f,))==doc
keep('pdf-read-1.json',one);keep('pdf-read-2.json',two)
check('PDF listed in the confirmed scope; admin only; pages 1 and 2 drawn by the isolated renderer with exact pixels; read proof names page, pixels and renderer; missing pages refused; original unchanged')

# ---- 2. selection, preview and delivery are bound to the page ------------------------------------------
regions=[{'x':300,'y':600,'width':100,'height':100},{'x':50,'y':50,'width':20,'height':20}]
b=selection(two,regions,doc);s,p,_=preview(b);assert s==200,(s,p)
out=png_image(base64.b64decode(p['png_base64']));assert out[:2]==(1000,1000) and px(out,350,650)==BLUE and px(out,60,60)==WHITE
for x,y in [(0,0),(299,650),(400,650),(350,599),(350,700),(500,500),(999,999)]:assert px(out,x,y)==BLACK,(x,y)
assert preview({**b,'width':1414,'height':707})[0]==400            # page 1's size with page 2
assert preview({**b,'receipt':{**b['receipt'],'page':1}})[0]==400   # page 1 with page 2's size
assert preview({**b,'receipt':{k:v for k,v in b['receipt'].items() if k!='page'}})[0]==400   # a PDF selection must name its page
_,g=attach(doc);s,first,_=read(g,1);assert s==200
assert preview({**selection(first,regions,doc),'receipt':{**first['receipt'],'page':2},'width':1000,'height':1000})[0]==409   # page 2 was never read on this receipt
png_receipt=SIG+b''.join(struct.pack('>I',len(v))+k+v+struct.pack('>I',zlib.crc32(k+v)&0xffffffff) for k,v in [(b'IHDR',struct.pack('>IIBBBBB',2,1,8,2,0,0,0)),(b'IDAT',zlib.compress(b'\0\xff\0\0\x63\x58\x4d')),(b'IEND',b'')])
_,image=attach(png_receipt,'image/png');assert read(image,1)[0]==400 and proofs(image)==0   # an image has no pages
s,plain,_=read(image);assert s==200 and 'page' not in plain['receipt'] and 'kind' not in plain['normalization']
assert preview({**selection(plain,[{'x':0,'y':0,'width':1,'height':1}],png_receipt),'receipt':{**plain['receipt'],'page':1}})[0]==400
s,d,p=issue(b);assert s==200,(s,d);did=d['id']
s,body,h=download(did);assert s==200 and body==base64.b64decode(p['png_base64']) and h['Content-Type']=='application/octet-stream'
assert download(did,ot)[0]==404 and download(did,pwd='wrong')[0]==401
assert sql('SELECT source_page FROM privacy_image_deliveries WHERE id=%s',(did,))==2 and sql('SELECT source_normalization FROM privacy_image_deliveries WHERE id=%s',(did,))==two['normalization']
listed=json.dumps(call('GET',f'/privacy/requests/{rid}/images',token=token)[1])
assert not any(k in listed for k in ['normalization','source_page','renderer','receipt_id','source_sha256','pixels','regions'])
check('selection uses the page as drawn; forged browser pixels ignored; unselected area black; a proof for one page does not cover another; images never take a page; delivery equals preview; other account and wrong password refused; requester sees no source metadata')

# ---- 3. damaged, oversized and encrypted documents -------------------------------------------------------
def refused(content,word,status=400):
 _,fid=attach(content);s,v,_=read(fid);assert s==status,(word,s,v);assert proofs(fid)==0
 if word:assert word in v['error'],(word,v)
refused(ENCRYPTED_USER,'암호');refused(ENCRYPTED_OWNER_ONLY,'암호')
refused(b'%PDF-1.7\n%%EOF\n','읽을 수 없습니다');refused(b'%PDF-1.7\n'+bytes(range(256))*200,'읽을 수 없습니다')
refused(blank(0),'읽을 수 없습니다')
refused(blank(201),'쪽수');refused(blank(1,'[0 0 20000 20000]'),'쪽 크기')
refused(bomb(),'처리하지 못했습니다')
_,largest=attach(padded());s,v,_=read(largest,1);assert s==200 and px(png_image(base64.b64decode(v['data_base64'])),100,100)==RED,(s,v)   # 5 MiB, the storage ceiling
_,edge=attach(blank(200));s,v,_=read(edge,200);assert s==200 and v['normalization']['pages']==200,(s,v)
s,v,_=read(f,1);assert s==200 and v['display_sha256']==one['display_sha256']   # the API and renderer are unaffected
check('encrypted (user and owner-only), unreadable, empty, 201-page, oversized-page, and decompression-bomb documents are refused with no read proof; a document at the 5 MiB storage ceiling and one at the 200-page limit still work; later reads are unaffected')

# ---- 4. source replacement, revocation and expiry ----------------------------------------------------------
s,raw,_=read(f,1);b1=selection(raw,[{'x':10,'y':10,'width':50,'height':50}],doc);s,d,_=issue(b1);assert s==200,(s,d);did=d['id'];assert download(did)[0]==200
replaced=document('0 1 0 rg 0 0 100 100 re f')
sql('UPDATE fleet_expense_receipts SET content=%s,digest=%s WHERE id=%s',(replaced,sha(replaced),f))
assert download(did)[0]==409 and payloads(did)==0 and preview(b1)[0]==409
s,raw,_=read(f,1);assert s==200 and raw['receipt']['receipt_revision']==2 and px(png_image(base64.b64decode(raw['data_base64'])),100,100)==(0,255,0)
assert preview(selection(raw,[{'x':10,'y':10,'width':50,'height':50}],doc))[0]==409      # the old hash with the new source
b2=selection(raw,[{'x':10,'y':10,'width':50,'height':50}],replaced);s,d,_=issue(b2);assert s==200,(s,d);did=d['id']
sql("UPDATE fleet_expenses SET note='edited' WHERE id=%s",(e,));assert download(did)[0]==409 and payloads(did)==0
s,raw,_=read(f,1);b3=selection(raw,[{'x':10,'y':10,'width':50,'height':50}],replaced);s,d,_=issue(b3);assert s==200,(s,d);did=d['id']
assert call('POST',f'/admin/privacy/images/{did}/revoke',{},at)[0]==200 and download(did)[0]==410 and payloads(did)==0
s,d,_=issue(b3);assert s==200,(s,d);expired=d['id'];sql('ALTER TABLE privacy_image_deliveries DISABLE TRIGGER privacy_image_delivery_immutable')
try:sql("UPDATE privacy_image_deliveries SET created_at=now()-interval '25 hours',expires_at=now()-interval '1 hour' WHERE id=%s",(expired,))
finally:sql('ALTER TABLE privacy_image_deliveries ENABLE TRIGGER privacy_image_delivery_immutable')
assert download(expired)[0]==410
for _ in range(80):
 if payloads(expired)==0:break
 time.sleep(1)
assert payloads(expired)==0
sql('UPDATE fleet_expense_receipts SET removed_at=now() WHERE id=%s',(f,));assert read(f,1)[0]==409
check('replaced bytes and expense edits block the delivery and purge its PNG; a replaced source needs a new read and selection; revoked and expired deliveries answer 410 and their PNG is removed; a removed source cannot be read')

# ---- 5. the renderer is confined where the API runs it -------------------------------------------------------
selftest=json.loads(subprocess.check_output(['docker','exec',API,'/gps-pdf-render','selftest']))
assert selftest['sandbox_holds'] and selftest['renders_inside_sandbox'] and all(selftest[k]['blocked'] for k in ['open_file','open_socket','start_program','start_process','too_much_memory','too_much_cpu']),selftest
left=subprocess.run(['docker','exec',API,'sh','-c','cat /proc/[0-9]*/comm 2>/dev/null | grep -c gps-pdf-render || true'],capture_output=True).stdout.strip()
assert left==b'0',left   # one process per page, none left behind
check('in the API container the renderer cannot open a file, open a socket, start a program or a process, or exceed its memory and CPU ceilings, and still renders; no renderer process outlives its request')

# ---- 6. simultaneous pages are refused, not queued ------------------------------------------------------------------
sql('DELETE FROM privacy_result_limits');now=company_state()['revision']
def raced(fid):return call('POST',path+f'/receipt-sources/{cr}/{fid}',{'company_revision':now,'page':1},at)[0]
with concurrent.futures.ThreadPoolExecutor(6) as pool:statuses=list(pool.map(raced,[g,edge,g,edge,g,edge]))
assert set(statuses)<={200,429} and 200 in statuses,statuses
assert read(g,1)[0]==200
check('simultaneous PDF pages answer 200 or 429 only and recover immediately')

# ---- 7. nothing temporary is left behind -----------------------------------------------------------------------------
for d in call('GET',path+'/images',token=at)[1]['items']:
 if not d['revoked_at']:assert call('POST',f"/admin/privacy/images/{d['id']}/revoke",{},at)[0]==200
assert sql('SELECT count(*) FROM gps_read_privacy_image_payloads p JOIN privacy_image_deliveries g ON g.id=p.delivery_id WHERE g.request_id=%s',(rid,))==0
check('revoking the remaining deliveries removes every temporary PNG of this request')
report={'integration_groups':len(passed),'groups':passed,'api_sha256':digest,'renderer_sha256':renderer,'schema':sql('SELECT max(version) FROM _sqlx_migrations'),'concurrent_statuses':statuses,'selftest':selftest}
assert report['schema']>=98,report['schema']
(pathlib.Path(__file__).parent/'receipt-pdf-validation.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
