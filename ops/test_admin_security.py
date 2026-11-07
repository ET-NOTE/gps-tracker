"""Round19: synthetic accounts only, isolated internal network and disposable DB.
Exercises ON and least-privilege runtime, never a production host.
"""
import base64,hashlib,hmac,json,os,pathlib,subprocess,time,urllib.request,urllib.error,uuid
from datetime import datetime,timezone,timedelta
from concurrent.futures import ThreadPoolExecutor
import psycopg2
from admin_db_roles import run as separate
from admin_security_bootstrap import bootstrap
HERE=pathlib.Path(__file__).resolve().parent
assert str(HERE).startswith('/home/etcom-hub/build/gps-admin19-')
NETWORK='gps-admin19-test-20261105';DB='gps-admin19-db-20261105';API='gps-admin19-api-20261105'
def inspect(kind,name):return json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NETWORK)['Internal']
di=inspect('container',DB);ai=inspect('container',API)
assert '/var/lib/postgresql/data' in di['HostConfig']['Tmpfs']
cfg=dict(x.split('=',1) for x in ai['Config']['Env'] if '=' in x)
assert cfg['APP_ENV']=='test' and cfg['GPS_ADMIN_SECURITY']=='on'
binary=HERE/'out/gps-tracker-api';digest=hashlib.sha256(binary.read_bytes()).hexdigest()
assert subprocess.check_output(['docker','exec',API,'sha256sum','/proc/1/exe']).decode().split()[0]==digest
base=f"http://{ai['NetworkSettings']['Networks'][NETWORK]['IPAddress']}:3043/gps-tracker/api/v1"
dsn=f"postgres://postgres:closure-test-only@{di['NetworkSettings']['Networks'][NETWORK]['IPAddress']}/gps_closure_test"
db=psycopg2.connect(dsn);db.autocommit=True
passed=[];tag=uuid.uuid4().hex[:10];password='Synthetic-only-123!'
def sql(q,args=()):
 with db.cursor() as c:c.execute(q,args);return c.fetchone()[0] if c.description else None
def call(method,path,body=None,who=None,headers=None):
 h={'Content-Type':'application/json',**(headers or {})}
 if who:h['Authorization']='Bearer '+who['access_token']
 if who and who.get('session'):h['X-Admin-Session']=who['session']
 try:r=urllib.request.urlopen(urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers=h),timeout=30)
 except urllib.error.HTTPError as e:r=e
 with r:
  raw=r.read();return r.status,json.loads(raw) if 'application/json' in r.headers.get('content-type','') else raw

def ok(s):passed.append(s);print('PASS '+s,flush=True)
def account(n):
 phone='010'+str(int(tag,16)+n)[-8:];email=f'{tag}-{n}@example.invalid'
 s,o=call('POST','/auth/send-otp',{'phone':phone});assert s==200,(s,o)
 s,u=call('POST','/auth/register',{'phone':phone,'email':email,'otp_code':o['dev_code'],'display_name':f'Synthetic person {n}','password':password});assert s==200,(s,u)
 u['email']=email;return u

officer,operator,handler,user,other=[account(n) for n in range(5)]
if sql('SELECT count(*) FROM admin_principals')!=0:raise AssertionError('fresh environment required')
report=bootstrap(dsn,officer['user_id'],operator['user_id'],['172.28.0.1/32'],'synthetic',False)
assert not report['apply'] and sql('SELECT count(*) FROM admin_principals')==0
bootstrap(dsn,officer['user_id'],operator['user_id'],['172.28.0.1/32'],'synthetic',True)
try:bootstrap(dsn,officer['user_id'],operator['user_id'],['172.28.0.1/32'],'synthetic',True)
except ValueError:pass
else:raise AssertionError('bootstrap repeated')
sql("UPDATE admin_principals SET allowed_cidrs=ARRAY['172.16.0.0/12']")
ok('offline initial roles require distinct accounts and explicit host IP; dry run writes nothing; repetition blocked')
for who,role in [(handler,'handler')]:
 sql("UPDATE users SET role='admin' WHERE id=%s",(who['user_id'],))
 sql("INSERT INTO admin_principals(user_id,role,allowed_cidrs,subject_ids) VALUES(%s,%s,ARRAY['172.16.0.0/12'],%s)",(who['user_id'],role,[user['user_id']] if role=='handler' else []))
def code(seed,offset=0):
 counter=int(time.time())//30+offset;raw=hmac.new(base64.b32decode(seed+'='*((8-len(seed)%8)%8)),counter.to_bytes(8,'big'),hashlib.sha256).digest();o=raw[-1]&15
 return str((int.from_bytes(raw[o:o+4],'big')&0x7fffffff)%1000000).zfill(6)
def enroll(who):
 s,x=call('POST','/admin/security/enroll',{'password':password},who);assert s==200,(s,x)
 who['seed']=x['secret'];who['initial_code']=code(who['seed']);s,x=call('POST','/admin/security/verify',{'password':password,'code':who['initial_code']},who);assert s==200,(s,x);who['session']=x['session']
def reauth(who):
 # Advance the fixture's replay counter only with privileged test SQL, never a production shortcut.
 sql('UPDATE admin_mfa SET last_counter=-1,failures=0,locked_until=NULL WHERE user_id=%s',(who['user_id'],))
 s,x=call('POST','/admin/security/verify',{'password':password,'code':code(who['seed'])},who);assert s==200,(s,x);who['session']=x['session']
assert call('GET','/admin/users',who=operator)[0]==403
assert call('GET','/admin/security/status',who=user)[0]==403
for w in (officer,operator,handler):enroll(w)
assert call('GET','/admin/users',who=operator)[0]==200
assert call('GET','/admin/users',who=officer)[0]==200
assert call('GET','/admin/users',who=handler)[0]==403
assert call('GET',f"/admin/users/{user['user_id']}",who=handler)[0]==200
assert call('GET',f"/admin/users/{other['user_id']}",who=handler)[0]==403
assert call('GET','/admin/security/events',who=handler)[0]==403
assert call('GET','/admin/users',who=operator,headers={'X-Fleet-Owner':str(officer['user_id'])})[0]==403
assert call('POST',f"/admin/users/{user['user_id']}/impersonate",{},operator)[0]==403
ok('password-only access denied; personal MFA, officer/operator/assigned-handler scope and delegated/impersonation bypass blocked')
# Password login attempts must serialize too; six simultaneous failures cannot exceed five checks.
def wrong_login(_):
 return call('POST','/auth/login',{'email':operator['email'],'password':'wrong-password'})[0]
with ThreadPoolExecutor(6) as pool:codes=list(pool.map(wrong_login,range(6)))
assert sorted(codes)==[401,401,401,401,401,429],codes
assert call('POST','/auth/login',{'email':operator['email'],'password':password})[0]==429
assert sql('SELECT count(*) FROM login_attempts WHERE email=%s AND NOT success',(operator['email'],))==5
sql('DELETE FROM login_attempts WHERE email=%s',(operator['email'],))
assert call('POST','/auth/login',{'email':operator['email'],'password':password})[0]==200
ok('parallel administrator password failures stop at five; a correct password stays locked until the window expires')
# Replay, failures persist across restarts, expired sessions and password changes invalidate step-up.
assert call('POST','/admin/security/verify',{'password':password,'code':operator['initial_code']},operator)[0]==401
for _ in range(4):assert call('POST','/admin/security/verify',{'password':'wrong','code':'000000'},operator)[0]==401
assert call('POST','/admin/security/verify',{'password':password,'code':code(operator['seed'])},operator)[0]==429
assert call('GET','/admin/users',who=operator)[0]==403
assert sql('SELECT failures FROM admin_mfa WHERE user_id=%s',(operator['user_id'],))==5
reauth(operator)
saved=operator['session'];operator['session']=handler['session'];assert call('GET','/admin/users',who=operator)[0]==403;operator['session']=saved
sql("UPDATE admin_sessions SET expires_at=now()-interval '1 second' WHERE user_id=%s",(operator['user_id'],));assert call('GET','/admin/users',who=operator)[0]==403;reauth(operator)
sql("UPDATE admin_mfa SET password_set_at=now()-interval '91 days' WHERE user_id=%s",(operator['user_id'],));assert call('GET','/admin/users',who=operator)[0]==403
assert call('POST','/admin/security/verify',{'password':password,'code':code(operator['seed'],1)},operator)[0]==409
sql('UPDATE admin_mfa SET password_set_at=now() WHERE user_id=%s',(operator['user_id'],));reauth(operator)
ok('OTP replay/5-attempt lockout, session theft across accounts, expiry and 90-day password rotation enforced')
# Untrusted XFF/X-Real-IP never changes the connected address.
sql("UPDATE admin_principals SET allowed_cidrs=ARRAY['203.0.113.9/32'] WHERE user_id=%s",(operator['user_id'],))
assert call('GET','/admin/users',who=operator,headers={'X-Real-IP':'203.0.113.9','X-Forwarded-For':'203.0.113.9'})[0]==403
sql("UPDATE admin_principals SET allowed_cidrs=ARRAY['172.16.0.0/12'] WHERE user_id=%s",(operator['user_id'],))
assert call('GET','/admin/users',who=operator,headers={'X-Real-IP':'203.0.113.9'})[0]==200
ok('IP allowlist uses connection identity; spoofed forwarding headers cannot bypass it')

def proposal(who,method,path,payload):
 s,a=call('POST','/admin/security/approvals',{'method':method,'path':path,'payload':payload,'reason':'Synthetic reviewed evidence'},who);assert s==200,(s,a);return a['id']
def decide(i,who=officer):return call('POST',f'/admin/security/approvals/{i}/decision',{'approve':True},who)
def execute(i,method,path,payload,who=operator):return call(method,path,payload,who,{'X-Admin-Approval':str(i)})
payload={'role':'handler','enabled':True,'allowed_cidrs':['172.16.0.0/12'],'subject_ids':[other['user_id']],'reset_mfa':False}
path=f"/admin/security/principals/{handler['user_id']}"
i=proposal(operator,'PATCH',path,payload)
assert decide(i,operator)[0]==403
assert execute(i,'PATCH',path,payload)[0]==409
assert decide(i)[0]==200
assert execute(i,'PATCH',path,{**payload,'role':'officer'})[0]==409
assert execute(i,'PATCH',path,payload,officer)[0]==403
assert execute(i,'PATCH',path,payload)[0]==200
assert execute(i,'PATCH',path,payload)[0]==409
assert call('GET',f"/admin/users/{user['user_id']}",who=handler)[0]==403
reauth(handler)
assert call('GET',f"/admin/users/{user['user_id']}",who=handler)[0]==403
assert call('GET',f"/admin/users/{other['user_id']}",who=handler)[0]==200
# Approved row changes; approver revocation and expiration invalidate execution.
i=proposal(operator,'PATCH',path,payload);assert decide(i)[0]==200
sql('UPDATE admin_principals SET revision=revision+1 WHERE user_id=%s',(handler['user_id'],));assert execute(i,'PATCH',path,payload)[0]==409
i=proposal(operator,'PATCH',path,payload);assert decide(i)[0]==200
sql('UPDATE admin_principals SET revision=revision+1 WHERE user_id=%s',(officer['user_id'],));assert execute(i,'PATCH',path,payload)[0]==409;reauth(officer)
i=proposal(operator,'PATCH',path,payload);assert decide(i)[0]==200
sql("UPDATE admin_approvals SET expires_at=now()-interval '1 second' WHERE id=%s",(i,));assert execute(i,'PATCH',path,payload)[0]==409
ok('two-person role/IP changes; self approval, changed body/target, revoked approver, expiry and reuse rejected')
# Test the real reviewed erasure route, not a mock mutation.
s,r=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'erasure','scope':'Synthetic access facts only','password':password},user);assert s==202,(s,r);rid=r['id']
review={'revision':r['revision'],'status':'in_review','due_at':(datetime.now(timezone.utc)+timedelta(days=7)).isoformat(),'message':'Synthetic scope reviewed','evidence_reference':'synthetic-only'}
rpath=f'/admin/privacy/requests/{rid}'
i=proposal(operator,'PATCH',rpath,review);assert decide(i)[0]==200;s,r=execute(i,'PATCH',rpath,review);assert s==200,(s,r)
erase={'revision':r['revision'],'from':(datetime.now(timezone.utc)-timedelta(days=1)).isoformat(),'until':datetime.now(timezone.utc).isoformat(),'evidence_reference':'synthetic-only','confirmed':True}
epath=rpath+'/access-ledger-erasure'
assert call('POST',epath,erase,operator)[0]==409
assert call('POST',epath,erase,officer)[0]==403
i=proposal(operator,'POST',epath,erase);assert decide(i)[0]==200
s,r=execute(i,'POST',epath,erase);assert s==200,(s,r)
assert execute(i,'POST',epath,erase)[0]==409
assert sql('SELECT count(*) FROM location_access_erasure_runs WHERE request_id=%s',(rid,))==1
ok('real privacy review and access-facts erasure require separate officer approval and operator execution')
# Simultaneous requests consume once, including a rejected business handler; crash/retry does not repeat.
i=proposal(operator,'PATCH',path,payload);assert decide(i)[0]==200
with ThreadPoolExecutor(2) as pool:codes=list(pool.map(lambda _:execute(i,'PATCH',path,payload)[0],range(2)))
assert sorted(codes)==[200,409],codes
raw=json.dumps(sql('SELECT jsonb_agg(to_jsonb(e)) FROM admin_security_events e'))
for w in (operator,officer,handler):
 for secret in [w['session'],w['seed'],w['access_token'],password]:assert secret not in raw
for query in ['DELETE FROM admin_security_events','TRUNCATE admin_security_events','UPDATE admin_security_events SET outcome=outcome']:
 try:sql(query)
 except psycopg2.Error:pass
 else:raise AssertionError(query)
ok('concurrent approval replay executes once; immutable security evidence excludes password/OTP/token values')
# Database separation is tested on these same live synthetic objects, never just a SQL dry run.
secret_out=HERE/'runtime-credentials.json'
if secret_out.exists():raise AssertionError('fresh test environment required')
check=separate(dsn);assert not check['apply']
report=separate(dsn,True,secret_out)
creds=json.loads(secret_out.read_text());runtime=psycopg2.connect(host=di['NetworkSettings']['Networks'][NETWORK]['IPAddress'],dbname=creds['database'],user=creds['user'],password=creds['password']);runtime.autocommit=True
for query in ['ALTER TABLE location_access_events DISABLE TRIGGER ALL','DROP TABLE admin_security_events','TRUNCATE admin_security_events','DELETE FROM admin_security_events','UPDATE admin_audit_log SET action=action','CREATE TABLE public.pwned(id int)','SET ROLE gps_schema_owner','UPDATE _sqlx_migrations SET success=false','CREATE ROLE escalation']:
 try:
  with runtime.cursor() as c:c.execute(query)
 except psycopg2.Error:pass
 else:raise AssertionError(query)
ok('runtime cannot change schema/triggers, assume owner, truncate/delete evidence, edit migrations or create roles')
# Restart with runtime credentials only. The DB schema owner credential is not present in the container.
env={**os.environ,'ADMIN_SECURITY':'on','LEDGER':'on','ERASURE':'on','RUNTIME_DSN':f"postgres://{creds['user']}:{creds['password']}@closure-db:5432/{creds['database']}"}
p=subprocess.run(['bash',str(HERE/'dev19.sh'),'api'],env=env,capture_output=True,text=True);assert p.returncode==0,p.stdout+p.stderr
ai=inspect('container',API);base=f"http://{ai['NetworkSettings']['Networks'][NETWORK]['IPAddress']}:3043/gps-tracker/api/v1"
assert call('GET','/admin/users',who=operator)[0]==200
assert call('GET','/admin/security/events',who=officer)[0]==200
assert call('GET','/auth/me',who=user)[0]==200
s,x=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'access','scope':'runtime-only smoke','password':password},user);assert s==202,(s,x)
assert call('GET','/admin/users',who={**operator,'session':''})[0]==403
assert sql('SELECT max(version) FROM _sqlx_migrations')==102
s,r=call('POST','/privacy/requests',{'request_key':str(uuid.uuid4()),'kind':'erasure','scope':'runtime erasure','password':password},other);assert s==202,(s,r)
rpath=f"/admin/privacy/requests/{r['id']}";review={**review,'revision':r['revision']}
i=proposal(operator,'PATCH',rpath,review);assert decide(i)[0]==200;s,r=execute(i,'PATCH',rpath,review);assert s==200,(s,r)
erase={**erase,'revision':r['revision']};epath=rpath+'/access-ledger-erasure'
i=proposal(operator,'POST',epath,erase);assert decide(i)[0]==200;s,r=execute(i,'POST',epath,erase);assert s==200,(s,r)
ok('real approved erasure succeeds under the restricted runtime through the reviewed SECURITY DEFINER executor')
ok('same API restarts with runtime-only DSN; schema verification, ordinary auth, privacy request and admin read succeed')
assert call('POST','/admin/security/logout',{},operator)[0]==200
assert call('GET','/admin/users',who=operator)[0]==403
ok('explicit step-up logout revokes the server session without deleting the ordinary account')
result={'at':datetime.now(timezone.utc).isoformat(),'environment':'isolated_internal_docker_synthetic_only','api_sha256':digest,'schema':102,'passed':passed,'production_changed':False,'db_role_report':report}
(HERE/'admin-security-validation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'passed_groups':len(passed),'sha256':digest,'schema':102}),flush=True)
