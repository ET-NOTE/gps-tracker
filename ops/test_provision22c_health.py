"""Synthetic offline conversion and live API regression. Internal Docker only."""
import base64, hashlib, json, os, pathlib, subprocess, urllib.request, urllib.error, uuid
import psycopg



HERE=pathlib.Path(__file__).resolve().parent
NET='gps-provision22-test-20261108c';DB='gps-provision22-db-20261108c';API='gps-provision22-api-20261108c'
assert str(HERE).startswith('/home/etcom-hub/build/gps-provision22-')
def inspect(kind,name):return json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NET)['Internal']
digest=hashlib.sha256((HERE/'out/gps-tracker-api').read_bytes()).hexdigest()
assert subprocess.check_output(['docker','exec',API,'sha256sum','/proc/1/exe']).decode().split()[0]==digest
assert '/var/lib/postgresql/data' in inspect('container',DB)['HostConfig']['Tmpfs']
dsn='postgres://postgres:closure-test-only@'+inspect('container',DB)['NetworkSettings']['Networks'][NET]['IPAddress']+'/gps_closure_test'
db=psycopg.connect(dsn,autocommit=True)
def sql(q,args=()):
 with db.cursor() as c:c.execute(q,args);return c.fetchone()[0] if c.description else None
def request(method,path,body=None,token=None,headers=None):
 host=inspect('container',API)['NetworkSettings']['Networks'][NET]['IPAddress']
 h={'Content-Type':'application/json',**(headers or {})}
 if token:h['Authorization']='Bearer '+token
 data=body if isinstance(body,bytes) else json.dumps(body).encode() if body is not None else None
 try:r=urllib.request.urlopen(urllib.request.Request('http://'+host+':3043/gps-tracker/api/v1'+path,method=method,data=data,headers=h),timeout=30)
 except urllib.error.HTTPError as e:r=e
 with r:
  global last_cache_control
  last_cache_control=r.headers.get('cache-control','')
  b=r.read();return r.status,json.loads(b) if 'application/json' in r.headers.get('content-type','') else b
if os.environ.get('STORAGE')=='pilot':
 ring=json.loads((HERE/'test-keys.json').read_text());sql("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ring),))
tag=uuid.uuid4().hex[:10];passed=[]
def ok(s):passed.append(s);print('PASS '+s,flush=True)
def account(n):
 phone='010'+str(int(tag,16)+n)[-8:]
 s,o=request('POST','/auth/send-otp',{'phone':phone});assert s==200,(s,o)
 s,u=request('POST','/auth/register',{'phone':phone,'email':f'{tag}-{n}@example.invalid','otp_code':o['dev_code'],'display_name':'Round22 fixture','password':'Synthetic-only-123!'});assert s==200,(s,u);return u



import time,hmac
from notice_queue_probe import probe
cred=json.loads((HERE/'test-runtime.json').read_text())
runtime=dsn.replace('postgres:closure-test-only',cred['user']+':'+cred['password'])
password='Synthetic-only-123!'
operator,officer,handler,user=[account(n) for n in range(1,5)]
for who,role in [(operator,'operator'),(officer,'officer'),(handler,'handler')]:
 sql("UPDATE users SET role='admin' WHERE id=%s",(who['user_id'],))
 sql("INSERT INTO admin_principals(user_id,role,allowed_cidrs,subject_ids) VALUES(%s,%s,ARRAY['172.16.0.0/12'],ARRAY[]::bigint[])",(who['user_id'],role))
# Security enforcement and subject/ledger ON, with push OFF, encrypted runtime.
sql("UPDATE location_subject_policy SET enabled=true,reference='synthetic-health-policy',push_enabled=false")
sql("UPDATE location_notice_worker SET seen_at=NULL,next_dispatch_at='-infinity',cooldown_until='-infinity'")
env=dict(os.environ,ADMIN_SECURITY='on',STORAGE='pilot',RUNTIME_DSN=runtime,LEDGER='on',SUBJECTS='on')
subprocess.run(['bash',str(HERE/'dev22.sh'),'api'],env=env,check=True)
path='/admin/security/notice-queue'
assert request('GET',path)[0]==401
assert request('GET',path,token=user['access_token'])[0]==403
assert request('GET',path,token=operator['access_token'])[0]==403
for who in [operator,officer,handler]:
 status,enrolled=request('POST','/admin/security/enroll',{'password':password},who['access_token']);assert status==200,(status,enrolled)
 seed=enrolled['secret'];raw=hmac.new(base64.b32decode(seed+'='*((8-len(seed)%8)%8)),(int(time.time())//30).to_bytes(8,'big'),hashlib.sha256).digest();o=raw[-1]&15
 code=str((int.from_bytes(raw[o:o+4],'big')&0x7fffffff)%1000000).zfill(6)
 status,result=request('POST','/admin/security/verify',{'password':password,'code':code},who['access_token']);assert status==200,(status,result)
 who['session']=result['session']
for who in [operator,officer]:
 status,result=request('GET',path,token=who['access_token'],headers={'X-Admin-Session':who['session']});assert status==200,(status,result)
 assert 'no-store' in {part.strip().lower() for part in last_cache_control.split(',')},last_cache_control
 assert 'alerts' in result and result['expected_running']
 assert not any(k in result for k in ['subject_id','token','email','lat','lng'])
assert request('GET',path,token=handler['access_token'],headers={'X-Admin-Session':handler['session']})[0]==403
sql("UPDATE admin_principals SET allowed_cidrs=ARRAY['203.0.113.1/32'] WHERE user_id=%s",(operator['user_id'],))
assert request('GET',path,token=operator['access_token'],headers={'X-Admin-Session':operator['session']})[0]==403
ok('anonymous/user/password-only/handler/wrong-IP denied; officer/operator MFA accepted on encrypted runtime')
assert sql("SELECT count(*) FROM admin_security_events WHERE route=%s",(path,))>0
# A SELECT-only monitor, independently alive after the API stops.
secret='synthetic-probe-'+uuid.uuid4().hex
db.execute(psycopg.sql.SQL('CREATE ROLE gps_notice_probe LOGIN PASSWORD {}').format(psycopg.sql.Literal(secret)))
sql('GRANT CONNECT ON DATABASE gps_closure_test TO gps_notice_probe')
sql('GRANT USAGE ON SCHEMA public TO gps_notice_probe')
sql('GRANT SELECT ON location_provision_notices,location_notice_attempts,location_subject_policy,location_notice_worker TO gps_notice_probe')
probe_file=HERE/'test-probe.json';probe_file.write_text(json.dumps({'dsn':dsn.replace('postgres:closure-test-only','gps_notice_probe:'+secret)}));probe_file.chmod(0o600)
health_sql=HERE/'src/gps-tracker-api/sql/subject_queue_health.sql'
subprocess.run(['bash',str(HERE/'dev22.sh'),'stop'],check=True)
sql("UPDATE location_notice_worker SET seen_at=now()-interval '61 seconds',provider_configured=false")
sql('UPDATE location_subject_policy SET push_enabled=true')
critical=probe(probe_file,health_sql,True)
assert critical['severity']=='critical' and 'worker_stale' in critical['alerts'] and 'provider_unconfigured' in critical['alerts']
cmd=[__import__('sys').executable,str(HERE/'src/ops/notice_queue_probe.py'),'--credential-file',str(probe_file),'--sql-file',str(health_sql),'--expect-running']
r=subprocess.run(cmd,capture_output=True,text=True);assert r.returncode==2 and json.loads(r.stdout)['severity']=='critical'
with psycopg.connect(json.loads(probe_file.read_text())['dsn'],autocommit=True) as monitor:
 try:monitor.execute('UPDATE location_notice_worker SET seen_at=now()')
 except psycopg.errors.InsufficientPrivilege:pass
 else:raise AssertionError('monitor can mutate')
probe_file.unlink()
probe_file.write_text('{"dsn":"postgres://synthetic:synthetic@127.0.0.1:1/no_db"}');probe_file.chmod(0o600)
r=subprocess.run(cmd,capture_output=True,text=True);assert r.returncode==2 and json.loads(r.stdout)=={'severity':'critical','alerts':['probe_failed']}
probe_file.unlink()
# Healthy fixture for clear/recovery snapshot (no evidence rows removed).
sql('UPDATE location_subject_policy SET push_enabled=false')
sql("UPDATE location_notice_worker SET seen_at=now(),provider_configured=true,cooldown_until=now()")
with psycopg.connect(runtime,autocommit=True) as run:
 run.execute("UPDATE location_notice_worker SET seen_at=now()")
 run.execute(health_sql.read_text().replace('$1','%s'),(True,)).fetchone()
 for q in ['DELETE FROM location_notice_worker','INSERT INTO location_notice_worker DEFAULT VALUES','UPDATE location_subject_policy SET push_enabled=true']:
  try:run.execute(q)
  except psycopg.errors.InsufficientPrivilege:pass
  else:raise AssertionError('runtime bypass')
ok('read-only independent probe detects stopped worker/missing provider/query failure; private output and runtime grants checked')
(HERE/'out/queue-critical-snapshot.json').write_text(json.dumps(critical,indent=2))
(HERE/'out/queue-health-verification.json').write_text(json.dumps({'schema':107,'api_sha256':digest,'passed':passed,'no_external_send':True,'production_modified':False},indent=2))
