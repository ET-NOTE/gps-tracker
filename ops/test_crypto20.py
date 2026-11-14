"""Round20 core-field/TLS validation. Synthetic data on an internal tmpfs DB only."""
import base64,hashlib,hmac,json,os,pathlib,ssl,subprocess,time,urllib.request,urllib.error,uuid
from datetime import datetime,timezone,timedelta
import psycopg2
from location_storage import create_keyring,run as convert
from admin_db_roles import run as separate

HERE=pathlib.Path(__file__).resolve().parent
assert str(HERE).startswith('/home/etcom-hub/build/gps-crypto20-')
NET='gps-crypto20-test-20261105';DB='gps-crypto20-db-20261105';API='gps-crypto20-api-20261105'
PROXY='gps-crypto20-proxy'
def inspect(kind,name):return json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NET)['Internal']
di=inspect('container',DB);assert '/var/lib/postgresql/data' in di['HostConfig']['Tmpfs']
dsn=f"postgres://postgres:closure-test-only@{di['NetworkSettings']['Networks'][NET]['IPAddress']}/gps_closure_test"
db=psycopg2.connect(dsn);db.autocommit=True
def sql(q,args=()):
 with db.cursor() as c:c.execute(q,args);return c.fetchone()[0] if c.description else None
assert sql('SELECT max(version) FROM _sqlx_migrations')==103
assert not sql('SELECT enabled FROM location_storage_policy')
passed=[];tag=uuid.uuid4().hex[:12]
def ok(s):passed.append(s);print('PASS '+s,flush=True)
def url():return 'http://'+inspect('container',API)['NetworkSettings']['Networks'][NET]['IPAddress']+':3043/gps-tracker'
def request(method,path,body=None,who=None,headers=None,origin=None,context=None):
 h={'Content-Type':'application/json',**(headers or {})}
 if who:h['Authorization']='Bearer '+who['access_token']
 raw=body if isinstance(body,bytes) else json.dumps(body).encode() if body is not None else None
 try:r=urllib.request.urlopen(urllib.request.Request((origin or url())+path,data=raw,headers=h,method=method),context=context,timeout=30)
 except urllib.error.HTTPError as e:r=e
 with r:
  b=r.read();return r.status,json.loads(b) if 'application/json' in r.headers.get('content-type','') else b
def account(n):
 phone='010'+str(int(tag,16)+n)[-8:]
 s,o=request('POST','/api/v1/auth/send-otp',{'phone':phone});assert s==200,(s,o)
 s,u=request('POST','/api/v1/auth/register',{'phone':phone,'email':f'{tag}-{n}@example.invalid','otp_code':o['dev_code'],'display_name':'Synthetic crypto','password':'Synthetic-only-123!'});assert s==200,(s,u);return u
owner,other=account(1),account(2)
uid='crypto-'+tag;iccid='8988228066614752021'
did=sql("INSERT INTO devices(device_uid,iccid,api_key_hash,owner_id) VALUES(%s,%s,'',%s) RETURNING id",('sim-'+tag,iccid,owner['user_id']))
secret=hashlib.sha256(os.urandom(32)).digest()
sql('INSERT INTO hardware_credentials(auth_uid,key_digest,authorized_owner_id) VALUES(%s,%s,%s)',(uid,secret,owner['user_id']))
counter=0
def wire():
 global counter
 counter+=1
 raw=json.dumps({'device_uid':uid,'iccid':iccid,'ts':counter*30,'boot':1,'l80':{'fix':True,'lat':37.12345678,'lng':127.87654321,'sat':12},'cbc_mv':4100,'event':'wake','wake':'motion'}).encode()
 sig=hmac.new(secret,f'{uid}\n{counter}\n'.encode()+raw,hashlib.sha256).hexdigest()
 return raw,{'X-GPS-Auth-Version':'2','X-GPS-Uid':uid,'X-GPS-Counter':str(counter),'X-GPS-Signature':sig}
raw,h=wire();s,x=request('POST','/ingest',raw,headers=h);assert s==200,(s,x)
assert sql('SELECT lat FROM location_records WHERE device_id=%s LIMIT 1',(did,))==37.12345678
baseline=sql('SELECT jsonb_agg(to_jsonb(r) ORDER BY recorded_at,source) FROM gps_read_location_records r WHERE device_id=%s',(did,))
ok('OFF mode retains existing signed ingestion and original coordinates')

subprocess.run(['bash',str(HERE/'dev20.sh'),'stop'],check=True)
keyfile=HERE/'test-keys.json';create_keyring(keyfile);ring=json.loads(keyfile.read_text())
sql("ALTER DATABASE gps_closure_test SET log_parameter_max_length='-1'")
try:convert(dsn,ring)
except ValueError as e:assert 'logging' in str(e)
else:raise AssertionError('unsafe database parameter logging accepted')
sql("ALTER DATABASE gps_closure_test SET log_parameter_max_length='0'")
ok('key loading refuses database bind-parameter logging before transmitting keys')
report=convert(dsn,ring,True,True,batch=1)
assert all(t['plaintext_rows']==0 for t in report['tables'].values()),report
sql("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ring),))
after=sql('SELECT jsonb_agg(to_jsonb(r) ORDER BY recorded_at,source) FROM gps_read_location_records r WHERE device_id=%s',(did,))
assert after==baseline
assert sql('SELECT last_lat FROM devices WHERE id=%s',(did,)) is None
assert sql('SELECT last_lat_sealed IS NOT NULL FROM devices WHERE id=%s',(did,))
assert sql('SELECT count(*) FROM events WHERE device_id=%s AND data IS NOT NULL',(did,))==0
ok('bounded conversion removes plaintext core fields and preserves exact decoded values')
env={**os.environ,'STORAGE':'pilot'}
subprocess.run(['bash',str(HERE/'dev20.sh'),'api'],env=env,check=True)
raw,h=wire();s,x=request('POST','/ingest',raw,headers=h);assert s==200,(s,x)
assert sql('SELECT count(*) FROM location_records WHERE device_id=%s AND (lat IS NOT NULL OR lng IS NOT NULL OR raw IS NOT NULL OR fixes_jsonb IS NOT NULL)',(did,))==0
for path in [f'/api/v1/devices',f'/api/v1/devices/{did}/locations']:
 s,x=request('GET',path,who=owner);assert s==200,(path,s,x)
 assert '37.12345678' in json.dumps(x),(path,x)
assert request('GET',f'/api/v1/devices/{did}/locations',who=other)[0] in (403,404)
assert request('GET',f'/api/v1/devices/{did}/locations')[0]==401
assert request('POST','/ingest',raw,headers=h)[0]==409
assert request('POST','/ingest',raw+b' ',headers=h)[0]==401
assert request('POST','/ingest',{'device_uid':uid,'iccid':iccid})[0]==401
ok('ON signed ingestion stores ciphertext; owner reads decrypt, other account/anonymous/replay/tamper/unsigned requests fail')
# Authentication follows hardware; ownership and history remain with the SIM.
uid='crypto-second-'+tag;secret=hashlib.sha256(os.urandom(32)).digest()
sql('INSERT INTO hardware_credentials(auth_uid,key_digest,authorized_owner_id) VALUES(%s,%s,%s)',(uid,secret,owner['user_id']))
raw,h=wire();s,x=request('POST','/ingest',raw,headers=h);assert s==200,(s,x)
assert sql('SELECT count(*) FROM devices WHERE iccid=%s',(iccid,))==1
assert sql('SELECT active_auth_uid FROM devices WHERE id=%s',(did,))==uid
assert sql('SELECT count(DISTINCT device_id) FROM location_records WHERE user_id=%s',(owner['user_id'],))==1
ok('new hardware authentication retains the same SIM device/history identity')


saved=sql('SELECT last_lat_sealed FROM devices WHERE id=%s',(did,))
def rejects(query,args=()):
 try:sql(query,args)
 except psycopg2.Error:return
 raise AssertionError('expected cryptographic rejection')
rejects("SELECT gps_open_cell(%s::jsonb,'wrong row')",(json.dumps(saved),))
missing_version=dict(saved);missing_version.pop('v')
rejects("SELECT gps_open_cell(%s::jsonb,gps_cell_context('devices',to_jsonb(d),ARRAY['id'],'last_lat')) FROM devices d WHERE id=%s",(json.dumps(missing_version),did))
broken=dict(saved);data=bytearray(base64.b64decode(saved['cipher']));data[len(data)//2]^=1;broken['cipher']=base64.b64encode(data).decode()
rejects("SELECT gps_open_cell(%s::jsonb,gps_cell_context('devices',to_jsonb(d),ARRAY['id'],'last_lat')) FROM devices d WHERE id=%s",(json.dumps(broken),did))
sql("SELECT set_config('gps.storage_keys','',false)")
rejects('SELECT last_lat FROM gps_read_devices WHERE id=%s',(did,))
rejects('UPDATE devices SET last_lat=1 WHERE id=%s',(did,))
sql("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ring),))
sql("SET timezone='Asia/Seoul'");assert sql('SELECT lat FROM gps_read_location_records WHERE device_id=%s LIMIT 1',(did,))==37.12345678
sql("SET timezone='UTC'")
ok('ciphertext corruption, context substitution and missing key fail closed; timestamp binding survives session timezone')

# Batch expansion, statistics functions and raw metadata are still usable.
with db.cursor() as c:
 c.execute("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng,raw,fixes_jsonb) VALUES(%s,%s,now(),'l80',true,37.12345678,127.87654321,%s,%s)",
 (did,owner['user_id'],json.dumps({'cbc_mv':4100,'boot_id':'synthetic'}),json.dumps([{'at_ms':-1000,'lat':37.12345678,'lng':127.87654321,'up_ms':1},{'at_ms':0,'lat':37.12355678,'lng':127.87664321,'up_ms':2}])))
assert sql('SELECT count(*) FROM location_history_points_between(%s,%s,NULL,NULL)',(did,owner['user_id']))>=3
sql('UPDATE devices SET last_lat=NULL,last_lng=NULL,last_fix_at=NULL WHERE id=%s',(did,))
assert sql('SELECT last_lat_sealed IS NULL AND last_lng_sealed IS NULL FROM devices WHERE id=%s',(did,))
ok('batched point expansion/history functions and explicit cached-location erasure work with encryption')
from urllib.parse import urlencode
at=sql("SELECT recorded_at FROM gps_read_location_records WHERE device_id=%s AND fixes_jsonb IS NOT NULL ORDER BY recorded_at DESC LIMIT 1",(did,))
window=urlencode({'from':(at-timedelta(milliseconds=1100)).isoformat(),'until':(at-timedelta(milliseconds=900)).isoformat()})
s,x=request('DELETE',f'/api/v1/devices/{did}/range?'+window,who=owner);assert s==200,(s,x)
assert sql('SELECT jsonb_array_length(fixes_jsonb) FROM gps_read_location_records WHERE device_id=%s AND recorded_at=%s',(did,at))==1
assert sql('SELECT raw_sealed IS NULL AND lat_sealed IS NULL AND lng_sealed IS NULL FROM location_records WHERE device_id=%s AND recorded_at=%s',(did,at))
ok('partial interval erasure preserves the remaining batch point and removes original payload/anchor ciphertext')


# Rotation is resumable; old keys are required until every old cell is rewrapped.
ring2={'active':'v2','keys':{**ring['keys'],'v2':base64.b64encode(os.urandom(32)).decode()}}
snapshot=sql('SELECT jsonb_agg(to_jsonb(r) ORDER BY recorded_at,source) FROM gps_read_location_records r WHERE device_id=%s',(did,))
subprocess.run(['bash',str(HERE/'dev20.sh'),'stop'],check=True)
rotation=convert(dsn,ring2,False,True,batch=1)
keyfile.write_text(json.dumps(ring2));sql("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ring2),))
assert sql('SELECT jsonb_agg(to_jsonb(r) ORDER BY recorded_at,source) FROM gps_read_location_records r WHERE device_id=%s',(did,))==snapshot
ring3={'active':'v2','keys':{'v2':ring2['keys']['v2']}}
assert all(t['plaintext_rows']==0 for t in convert(dsn,ring3)['tables'].values())
ok('one-row rotation checkpoints preserve values; old key can be removed only after a complete decrypt scan')

# Logical backup contains ciphertext, no key or sample coordinates; restore the
# protected rows into disposable snapshot tables to exercise decrypt recovery.
dump=subprocess.check_output(['docker','exec',DB,'pg_dump','-U','postgres','-d','gps_closure_test','--data-only','--inserts','-t','devices','-t','events','-t','location_records'])
assert b'37.12345678' not in dump and b'127.87654321' not in dump
assert all(v.encode() not in dump for v in ring2['keys'].values())
# Timescale's parent has no heap rows: pg_dump of the full DB also covers chunks.
full_dump=subprocess.check_output(['docker','exec',DB,'pg_dump','-U','postgres','-d','gps_closure_test','--data-only','--inserts'])
assert b'37.12345678' not in full_dump and b'127.87654321' not in full_dump
assert all(v.encode() not in full_dump for v in ring2['keys'].values())
archive=subprocess.check_output(['docker','exec',DB,'pg_dump','-U','postgres','-d','gps_closure_test','-Fc'])
subprocess.run(['docker','exec',DB,'createdb','-U','postgres','gps_crypto_restore'],check=True)
subprocess.run(['docker','exec',DB,'psql','-U','postgres','-d','gps_crypto_restore','-v','ON_ERROR_STOP=1','-c','CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();'],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['docker','exec','-i',DB,'pg_restore','-U','postgres','-d','gps_crypto_restore','--exit-on-error'],input=archive,check=True)
subprocess.run(['docker','exec',DB,'psql','-U','postgres','-d','gps_crypto_restore','-v','ON_ERROR_STOP=1','-c','SELECT timescaledb_post_restore();'],check=True,stdout=subprocess.DEVNULL)
restored=psycopg2.connect(dsn.rsplit('/',1)[0]+'/gps_crypto_restore');restored.autocommit=True
with restored.cursor() as c:
 try:c.execute('SELECT lat FROM gps_read_location_records LIMIT 1')
 except psycopg2.Error:pass
 else:raise AssertionError('restored ciphertext opened without keys')
 c.execute("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ring3),))
 c.execute('SELECT jsonb_agg(to_jsonb(r) ORDER BY recorded_at,source) FROM gps_read_location_records r WHERE device_id=%s',(did,))
 assert c.fetchone()[0]==snapshot
with restored.cursor() as c:c.execute('SELECT timescaledb_pre_restore()')
restored.close()
# Both databases live in the same throwaway tmpfs container and are removed by dev20.sh down.
# Do not race Timescale background-worker exit with DROP DATABASE.
ok('full Timescale pg_dump/pg_restore recovers exact core values only with separately retained keys; dumps contain no sample plaintext/keys')

# A real TLS terminating Nginx overwrites metadata. No public ports are exposed.
proxy_dir=HERE/'tls-fixture';proxy_dir.mkdir(exist_ok=True)
subprocess.run(['docker','create','--name',PROXY,'--network',NET,'--cap-drop=ALL','--cap-add=SETUID','--cap-add=SETGID','--cap-add=CHOWN','--cap-add=DAC_OVERRIDE','--security-opt=no-new-privileges','-v',f'{proxy_dir}:/fixture:ro','nginx:stable-alpine','nginx','-c','/fixture/nginx.conf','-g','daemon off;'],check=True,stdout=subprocess.DEVNULL)
proxy_ip=inspect('container',PROXY)['NetworkSettings']['Networks'][NET]['IPAddress']
if not proxy_ip:
 # Docker assigns addresses on start; reserve a host address from this isolated subnet.
 subnet=inspect('network',NET)['IPAM']['Config'][0]['Subnet'];proxy_ip=subnet.rsplit('.',1)[0]+'.4'
 subprocess.run(['docker','network','disconnect',NET,PROXY],check=True)
 subprocess.run(['docker','network','connect','--ip',proxy_ip,NET,PROXY],check=True)
subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(proxy_dir/'key.pem'),'-out',str(proxy_dir/'cert.pem'),'-subj','/CN=GPS synthetic TLS','-addext',f'subjectAltName=IP:{proxy_ip}'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
env.update(TLS_REQUIRED='on',TLS_PROXY=proxy_ip+'/32')
subprocess.run(['bash',str(HERE/'dev20.sh'),'api'],env=env,check=True)
api_ip=inspect('container',API)['NetworkSettings']['Networks'][NET]['IPAddress']
(proxy_dir/'nginx.conf').write_text(f'''pid /tmp/nginx.pid; events {{}} http {{ access_log off; server {{ listen 8443 ssl; ssl_protocols TLSv1.2 TLSv1.3; ssl_certificate /fixture/cert.pem; ssl_certificate_key /fixture/key.pem; location / {{ proxy_pass http://{api_ip}:3043; proxy_set_header X-GPS-TLS-Version $ssl_protocol; }} }} server {{ listen 8080; location / {{ return 426; }} }} }}''')
subprocess.run(['docker','start',PROXY],check=True,stdout=subprocess.DEVNULL);time.sleep(1)
raw,h=wire()
assert request('POST','/ingest',raw,headers={**h,'X-GPS-TLS-Version':'TLSv1.2','X-Forwarded-Proto':'https'})[0]==426
ctx=ssl.create_default_context(cafile=str(proxy_dir/'cert.pem'));ctx.minimum_version=ctx.maximum_version=ssl.TLSVersion.TLSv1_2
s,x=request('POST','/gps-tracker/ingest',raw,headers={**h,'X-GPS-TLS-Version':'TLSv1.0'},origin=f'https://{proxy_ip}:8443',context=ctx);assert s==200,(s,x)
assert request('POST','/gps-tracker/ingest',raw,headers=h,origin=f'http://{proxy_ip}:8080')[0]==426
assert request('POST','/gps-tracker/ingest',raw+b' ',headers=h,origin=f'https://{proxy_ip}:8443',context=ctx)[0]==401
ok('real Nginx TLS 1.2 succeeds; HTTP, direct spoofed proxy headers and invalid signatures fail')
# The separated serving identity cannot turn encryption off or disable triggers.
subprocess.run(['bash',str(HERE/'dev20.sh'),'stop'],check=True)
credfile=HERE/'test-runtime.json';separate(dsn,True,credfile)
cred=json.loads(credfile.read_text());env['RUNTIME_DSN']=dsn.replace('postgres:closure-test-only',cred['user']+':'+cred['password'])
subprocess.run(['bash',str(HERE/'dev20.sh'),'api'],env=env,check=True)
runtime=psycopg2.connect(env['RUNTIME_DSN']);runtime.autocommit=True
with runtime.cursor() as c:
 for q in ['UPDATE location_storage_policy SET enabled=false','ALTER TABLE devices DISABLE TRIGGER ALL','DROP VIEW gps_read_devices']:
  try:c.execute(q)
  except psycopg2.Error:pass
  else:raise AssertionError('runtime changed encryption controls')
runtime.close()
raw,h=wire();s,x=request('POST','/gps-tracker/ingest',raw,headers=h,origin=f'https://{proxy_ip}:8443',context=ctx);assert s==200,(s,x)
s,x=request('GET',f'/api/v1/devices/{did}/locations',who=owner);assert s==200 and '37.12345678' in json.dumps(x),(s,x)
ok('restricted runtime can ingest/read encrypted rows but cannot disable encryption, alter triggers or drop views')

result={'synthetic':True,'production_modified':False,'schema':103,'passed':passed,'conversion':report,'rotation':rotation,'api_sha256':hashlib.sha256((HERE/'out/gps-tracker-api').read_bytes()).hexdigest()}
(HERE/'out/crypto20-validation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
subprocess.run(['docker','rm','-f',PROXY],check=True,stdout=subprocess.DEVNULL)
print(json.dumps({'passed':len(passed),'evidence':'out/crypto20-validation.json'}))
