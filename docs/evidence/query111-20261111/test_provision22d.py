"""Synthetic offline conversion and live API regression. Internal Docker only."""
import base64, hashlib, json, os, pathlib, subprocess, urllib.request, urllib.error, uuid
import psycopg



HERE=pathlib.Path(__file__).resolve().parent
NET='gps-provision22-test-20261111cumulative111';DB='gps-provision22-db-20261111cumulative111';API='gps-provision22-api-20261111cumulative111'
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
  b=r.read();return r.status,json.loads(b) if 'application/json' in r.headers.get('content-type','') else b
if os.environ.get('STORAGE')=='pilot':
 ring=json.loads((HERE/'test-keys.json').read_text());sql("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ring),))
tag=uuid.uuid4().hex[:10];passed=[]
def ok(s):passed.append(s);print('PASS '+s,flush=True)
def account(n):
 phone='010'+str(int(tag,16)+n)[-8:]
 s,o=request('POST','/auth/send-otp',{'phone':phone});assert s==200,(s,o)
 s,u=request('POST','/auth/register',{'phone':phone,'email':f'{tag}-{n}@example.invalid','otp_code':o['dev_code'],'display_name':'Round22 fixture','password':'Synthetic-only-123!'});assert s==200,(s,u);return u


from datetime import datetime,timedelta,timezone
from urllib.parse import urlencode

owner,driver,other,driver2=account(1),account(2),account(3),account(4)
u=owner['user_id'];s=driver['user_id'];s2=driver2['user_id'];token=owner['access_token'];dtoken=driver['access_token'];d2token=driver2['access_token']
start=datetime.now(timezone.utc).replace(microsecond=0)-timedelta(hours=2)
a_end=start+timedelta(minutes=10);b_start=start+timedelta(minutes=15);end=start+timedelta(minutes=25)
did=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,%s,'') RETURNING id",(u,'projection-'+tag))
v=sql("INSERT INTO fleet_vehicles(owner_id,name,license_plate) VALUES(%s,'정보주체 검증 차량','합성22B') RETURNING id",(u,))
bind=sql("INSERT INTO fleet_vehicle_bindings(owner_id,vehicle_id,device_id,terminal_name,started_at,is_primary) VALUES(%s,%s,%s,'SIM fixture',%s,true) RETURNING id",(u,v,did,start-timedelta(days=1)))
sql("INSERT INTO subscriptions(user_id,kind,expires_at) VALUES(%s,'corporate_report',now()+interval '1 day')",(u,))
def member(who):
 sid=sql("INSERT INTO staff(user_id,name,active,access_role,all_vehicles) VALUES(%s,'합성 직원',true,'member',false) RETURNING id",(u,))
 sql('INSERT INTO fleet_staff_accounts(owner_id,staff_id,account_id) VALUES(%s,%s,%s)',(u,sid,who));return sid
sid=member(s);sid2=member(s2)
sql('INSERT INTO fleet_staff_vehicles(owner_id,staff_id,vehicle_id) VALUES(%s,%s,%s)',(u,sid,v))
sql("UPDATE location_subject_policy SET enabled=true,reference='isolated-22b',push_enabled=false")
subprocess.run(['bash',str(HERE/'dev22.sh'),'api'],env=dict(os.environ,LEDGER='on',SUBJECTS='on'),check=True)
def mapping(staff,at,until,who):
 code,m=request('POST','/corporate/subject-mappings',{'request_key':str(uuid.uuid4()),'staff_id':staff,'binding_id':bind,'starts_at':at.isoformat(),'ends_at':until.isoformat()},token);assert code==200,(code,m)
 code,r=request('POST',f"/privacy/subject-mappings/{m['id']}/decision",{'action':'confirmed','revision':0,'consent_version':'fleet-subject-v1'},who);assert code==200,(code,r);return m['id']

exec(compile((HERE/'src/ops/test_provision22d_cases.py').read_text(), 'test_provision22d_cases.py', 'exec'))
