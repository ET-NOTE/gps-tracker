"""Invitation, organization and delegated access regression. Private clone only."""
import base64,datetime,hashlib,hmac,io,json,pathlib,sys,time,urllib.error,urllib.parse,urllib.request,uuid,zipfile
from concurrent.futures import ThreadPoolExecutor
import psycopg2
envpath,base=sys.argv[1:3]
assert base=='http://127.0.0.1:3042'
env={k:v.strip().strip('"').strip("'") for k,v in (l.split('=',1) for l in pathlib.Path(envpath).read_text().splitlines() if '=' in l and not l.startswith('#'))}
assert urllib.parse.urlsplit(env['DATABASE_URL']).path=='/gps_tracker_dev_prodreview_20261020'
db=psycopg2.connect(env['DATABASE_URL']);db.autocommit=True;cur=db.cursor();users=[];devices=[];run=uuid.uuid4().hex;checks=[]
def sql(q,args=()):
 cur.execute(q,args);return cur.fetchone()[0] if cur.description else None
def jwt(user):
 enc=lambda v:base64.urlsafe_b64encode(json.dumps(v).encode()).rstrip(b'=')
 raw=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'sub':str(user),'typ':'access','iat':int(time.time()),'exp':int(time.time())+1800})
 return (raw+b'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),raw,hashlib.sha256).digest()).rstrip(b'=')).decode()
def call(user,method,path,body=None,expected=200,owner=None,binary=False):
 headers={'Content-Type':'application/json'}
 if user:headers['Authorization']='Bearer '+jwt(user)
 if owner:headers['X-Fleet-Owner']=str(owner)
 req=urllib.request.Request(base+'/gps-tracker/api/v1'+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
 try:
  with urllib.request.urlopen(req,timeout=45) as res:status=res.status;data=res.read()
 except urllib.error.HTTPError as e:status=e.code;data=e.read()
 if expected is None:return status
 assert status==expected,(method,path,status,data[:180])
 return data if binary else json.loads(data)
def check(name,condition=True):assert condition,name;checks.append(name)

def upload(user,path,fields,image):
 boundary='team-fixture-'+run
 data=b''
 for name,value in fields.items():data+=(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n').encode()
 data+=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n').encode()+image+f'\r\n--{boundary}--\r\n'.encode()
 req=urllib.request.Request(base+'/gps-tracker/api/v1'+path,data=data,headers={'Authorization':'Bearer '+jwt(user),'Content-Type':'multipart/form-data; boundary='+boundary})
 with urllib.request.urlopen(req) as res:return json.loads(res.read())
def staff(owner,name,**kw):return call(owner,'POST','/corporate/staff',dict(name=name,**kw))
def item(owner,kind,name):return call(owner,'POST','/corporate/organization/items',dict(kind=kind,name=name,active=True))
def vehicle(owner,name,dep):return call(owner,'POST','/corporate/vehicles',dict(name=name,department_id=dep,enabled=True,profile={}))
def invite(owner,s):return call(owner,'POST','/corporate/invites',dict(staff_id=s['id']))
def accept(owner,s,user):
 i=invite(owner,s);r=call(user,'POST','/corporate/join',dict(code=i['code'],confirm=False))
 assert r['owner_id']==owner and r['staff_id']==s['id']
 assert not sql('SELECT EXISTS(SELECT 1 FROM fleet_staff_accounts WHERE owner_id=%s AND account_id=%s)',(owner,user))
 call(user,'POST','/corporate/join',dict(code=i['code'],confirm=True));return i
try:
 for label in ['owner','admin','member','outsider']:
  users.append(sql("INSERT INTO users(email,password_hash,display_name) VALUES(%s,'test-only','CSV regression') RETURNING id",(f'import-{run}-{label}@example.invalid',)))
 a,admin,member,outsider=users
 dep=item(a,'department','영업부');pos=item(a,'position','팀장')
 sa=staff(a,'관리 담당',access_role='admin');sm=staff(a,'직원');accept(a,sa,admin);accept(a,sm,member)
 endpoint='/corporate/staff/import'
 rows=[dict(name=' 김등록 ',phone='010-1234-5678',department='영업부',position='팀장',role='배차'),dict(name='박등록')]
 def preview(rows,actor=a):return call(actor,'POST',endpoint,dict(rows=rows),owner=a if actor!=a else None)
 def commit(rows,p,actor=a,expected=200):return call(actor,'POST',endpoint,dict(rows=rows,confirm=True,token=p['token']),expected,owner=a if actor!=a else None)
 count=lambda:sql('SELECT count(*) FROM staff WHERE user_id=%s',(a,))
 before=count();p=preview(rows)
 check('preview normalizes without writes',p['ready']==2 and p['rows'][0]['name']=='김등록' and count()==before)
 call(None,'POST',endpoint,dict(rows=rows),401)
 for actor in [member,outsider]:call(actor,'POST',endpoint,dict(rows=rows),403,owner=a)
 check('unauthenticated member and foreign company rejected')
 for bad in [[],[dict(name='a')]*501]:call(a,'POST',endpoint,dict(rows=bad),400)
 call(a,'POST',endpoint,dict(rows=[dict(name='a',access_role='admin')]),422)
 check('limits and privilege fields rejected')
 bad=rows+[dict(name='오류',phone='not-phone',department='타회사 부서'),dict(name='x'*65)]
 pbad=preview(bad);check('row validation exposes actionable errors',pbad['errors']==2 and len(pbad['rows'][2]['errors'])==2)
 commit(bad,pbad,expected=400);check('invalid batch leaves no partial users',count()==before)
 commit(rows,{**p,'token':'fake'},expected=409)
 changed=rows+[dict(name='새 직원')];commit(changed,p,expected=409)
 check('confirmation is bound to reviewed values')
 p=preview(rows,admin);saved=commit(rows,p,admin)
 check('delegated admin imports two users atomically',len(saved['created'])==2 and count()==before+2)
 cur.execute('SELECT access_role,all_vehicles,active,department_id,position_id FROM staff WHERE id=ANY(%s) ORDER BY id',(saved['created'],));stored=cur.fetchall()
 check('imports cannot grant fleet access or create logins',all(r[:3]==('member',False,True) for r in stored) and stored[0][3:]==(dep['id'],pos['id']) and sql('SELECT count(*) FROM fleet_staff_accounts WHERE staff_id=ANY(%s)',(saved['created'],))==0 and sql('SELECT count(*) FROM fleet_invites WHERE staff_id=ANY(%s)',(saved['created'],))==0)
 commit(rows,p,admin,409);check('replayed confirmation cannot duplicate',count()==before+2)
 p=preview(rows);check('re-upload skips existing rows',p['skipped']==2 and p['ready']==0);commit(rows,p);check('skip retains existing permissions',count()==before+2)
 renamed=[dict(name='다른 이름',phone='01012345678')];check('same phone different name is a conflict',preview(renamed)['errors']==1)
 repeat=[dict(name='중복',phone='01011112222'),dict(name='중복',phone='010-1111-2222')];p=preview(repeat);check('file duplicates normalize phone',p['ready']==1 and p['skipped']==1)
 with ThreadPoolExecutor(max_workers=2) as ex:statuses=list(ex.map(lambda _:call(a,'POST',endpoint,dict(rows=repeat,confirm=True,token=p['token']),expected=None),range(2)))
 check('concurrent confirmation creates once',sorted(statuses)==[200,409])
 different=[dict(name='새 이름')];p=preview(different);staff(a,'외부 변경');commit(different,p,expected=409)
 check('staff changes invalidate preview')
 p=preview(different);item(a,'position','사원');commit(different,p,expected=409);check('organization changes invalidate preview')
 p=preview([dict(name='비활성 조직',department='영업부')]);call(a,'PUT',f"/corporate/organization/items/{dep['id']}",dict(kind='department',name='영업부',active=False,updated_at=dep['updated_at']))
 commit([dict(name='비활성 조직',department='영업부')],p,expected=409);check('inactive department cannot be imported',preview([dict(name='비활성 조직',department='영업부')])['errors']==1)
 logs=call(a,'GET','/corporate/team-audit');check('batch audit records true actor and created IDs',any(r['action']=='staff_import' and r['actor_id']==admin and r['after_value']['staff_ids']==saved['created'] for r in logs))
 check('scope cannot be replayed to another owner',call(outsider,'POST',endpoint,dict(rows=rows,confirm=True,token=p['token']),expected=None)==409)
 print(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False))
finally:
 if users:
  cur.execute('DELETE FROM staff WHERE user_id=ANY(%s)',(users,))
  cur.execute('DELETE FROM users WHERE id=ANY(%s)',(users,))
 db.close()
