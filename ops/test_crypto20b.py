"""Synthetic offline conversion and live API regression. Internal Docker only."""
import base64, hashlib, json, os, pathlib, subprocess, urllib.request, urllib.error, uuid
import psycopg
from location_storage import create_keyring, run as convert
from crypto20b_transition import run as transition, MAGIC

HERE=pathlib.Path(__file__).resolve().parent
NET='gps-crypto20b-test-20261105';DB='gps-crypto20b-db-20261105';API='gps-crypto20b-api-20261105'
assert str(HERE).startswith('/home/etcom-hub/build/gps-crypto20b-')
def inspect(kind,name):return json.loads(subprocess.check_output(['docker',kind,'inspect',name]))[0]
assert inspect('network',NET)['Internal']
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
tag=uuid.uuid4().hex[:10];passed=[]
def ok(s):passed.append(s);print('PASS '+s,flush=True)
def account(n):
 phone='010'+str(int(tag,16)+n)[-8:]
 s,o=request('POST','/auth/send-otp',{'phone':phone});assert s==200,(s,o)
 s,u=request('POST','/auth/register',{'phone':phone,'email':f'{tag}-{n}@example.invalid','otp_code':o['dev_code'],'display_name':'Crypto20B fixture','password':'Synthetic-only-123!'});assert s==200,(s,u);return u
owner,other=account(1),account(2);token=owner['access_token'];oid=owner['user_id']
did=sql("INSERT INTO devices(owner_id,device_uid,api_key_hash) VALUES(%s,%s,'') RETURNING id",(oid,'crypto20b-'+tag))
fid=sql("INSERT INTO geofences(owner_id,name,center_lat,center_lng,radius_m,user_id) VALUES(%s,'SECRET-FENCE',37.12345678,127.87654321,100,%s) RETURNING id",(oid,oid))
sid=sql("INSERT INTO fleet_sites(owner_id,name,address,geometry) VALUES(%s,'SECRET-SITE','SECRET-ADDRESS','{\"type\":\"circle\",\"lat\":37.12345678,\"lng\":127.87654321,\"radius_m\":100}') RETURNING id",(oid,))
sql("INSERT INTO ai_analyses(user_id,device_id,target_date,analysis) VALUES(%s,%s,current_date,'SECRET-ANALYSIS 37.12345678')",(oid,did))
sql("INSERT INTO geocode_cache(lat_q,lng_q,road) VALUES(371234,1278765,'SECRET-ROAD')")
for table in ['location_1min','location_5min','location_1hour']:
 sql(f"INSERT INTO {table}(device_id,bucket,lat_avg,lng_avg,lat_last,lng_last) VALUES(%s,now(),37.12345678,127.87654321,37.12345678,127.87654321)",(did,))
sql("INSERT INTO location_records(device_id,user_id,source,recorded_at,lat,lng,fix) VALUES(%s,%s,'l80',now(),37.12345678,127.87654321,true)",(did,oid))
def upload(data):
 boundary='crypto20b'+tag
 body=(f'--{boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nother\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.pdf"\r\nContent-Type: application/pdf\r\n\r\n').encode()+data+f'\r\n--{boundary}--\r\n'.encode()
 return request('POST',f'/devices/{did}/documents',body,token,{'Content-Type':'multipart/form-data; boundary='+boundary})
raw=b'%PDF-1.4\nSECRET-LOCATION-37.12345678\n%%EOF'
s,doc=upload(raw);assert s==200,(s,doc)
path=pathlib.Path(sql('SELECT stored_path FROM device_documents WHERE id=%s',(doc['id'],)))
assert path.read_bytes()==raw
baseline=sql('SELECT jsonb_agg(snapshot ORDER BY id) FROM fleet_site_versions WHERE site_id=%s',(sid,))
ok('OFF upload and derived values remain compatible')
keyfile=HERE/'test-keys.json';create_keyring(keyfile);ring=json.loads(keyfile.read_text())
uploads=str(HERE/'test-storage/uploads');private=str(HERE/'test-storage/private')
try:transition(dsn,ring,uploads,private,'fence')
except ValueError as e:assert 'sessions' in str(e)
else:raise AssertionError('online writer fence accepted')
db.close();subprocess.run(['bash',str(HERE/'dev20b.sh'),'stop'],check=True)
transition(dsn,ring,uploads,private,'fence')
conversion=transition(dsn,ring,uploads,private,'convert')
assert conversion['ready_to_start_key_configured_api'] and conversion['files']['converted']==1
assert path.read_bytes().startswith(MAGIC) and raw not in path.read_bytes()
transition(dsn,ring,uploads,private,'resume')
db=psycopg.connect(dsn,autocommit=True);sql("SELECT set_config('gps.storage_keys',%s,false)",(json.dumps(ring),))
assert sql('SELECT jsonb_agg(snapshot ORDER BY id) FROM gps_read_fleet_site_versions WHERE site_id=%s',(sid,))==baseline
assert sql('SELECT center_lat FROM geofences WHERE id=%s',(fid,)) is None
assert sql('SELECT center_lat FROM gps_read_geofences WHERE id=%s',(fid,))==37.12345678
ok('offline fenced conversion preserves versions, legacy aggregates, AI, cache and file bytes')
subprocess.run(['bash',str(HERE/'dev20b.sh'),'api'],env={**os.environ,'STORAGE':'pilot'},check=True)
assert request('GET',f"/documents/{doc['id']}/download",token=token)==(200,raw)
assert request('GET',f"/documents/{doc['id']}/preview",token=other['access_token'])[0]==404
assert request('GET',f"/documents/{doc['id']}/preview")[0]==401
s,second=upload(raw+b'\nnew');assert s==200,(s,second)
secondpath=pathlib.Path(sql('SELECT stored_path FROM device_documents WHERE id=%s',(second['id'],)))
assert secondpath.read_bytes().startswith(MAGIC)
assert request('GET',f"/documents/{second['id']}/preview",token=token)==(200,raw+b'\nnew')
original=secondpath.read_bytes();secondpath.write_bytes(path.read_bytes())
assert request('GET',f"/documents/{second['id']}/download",token=token)[0]!=200
secondpath.write_bytes(raw)
assert request('GET',f"/documents/{second['id']}/download",token=token)[0]!=200
secondpath.write_bytes(original)
ok('encrypted uploads and downloads enforce ownership; swapped ciphertext and plaintext fail closed')
s,x=request('PATCH',f'/geofences/{fid}',{'name':'Changed fence'},token)
if s==405:s,x=request('PUT',f'/geofences/{fid}',{'name':'Changed fence'},token)
assert s==200,(s,x)
assert sql('SELECT center_lat FROM gps_read_geofences WHERE id=%s',(fid,))==37.12345678
assert sql('SELECT center_lat FROM geofences WHERE id=%s',(fid,)) is None
ok('partial geofence update retains unchanged encrypted coordinates')
try:sql('UPDATE geofences SET center_lat=NULL WHERE id=%s',(fid,))
except psycopg.Error:pass
else:raise AssertionError('logical required constraint bypassed')
sql("SET timezone='Asia/Seoul'")
assert sql('SELECT lat_avg FROM gps_read_location_1min WHERE device_id=%s',(did,))==37.12345678
ok('logical NOT NULL constraints and timezone-stable archive contexts survive encryption')
(HERE/'out/20b-conversion.json').write_text(json.dumps({'groups':passed,'conversion':conversion,'api_sha256':hashlib.sha256((HERE/'out/gps-tracker-api').read_bytes()).hexdigest()},indent=2))
db.close()
