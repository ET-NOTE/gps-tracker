"""Production-shaped security regression. All writes require a private review clone."""
import base64
import concurrent.futures
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import psycopg2

env_path,base=sys.argv[1:3]
assert base=='http://127.0.0.1:3042'
env=dict(line.split('=',1) for line in Path(env_path).read_text().splitlines() if '=' in line and not line.startswith('#'))
env={k:v.strip().strip('"').strip("'") for k,v in env.items()}
assert urllib.parse.urlsplit(env['DATABASE_URL']).path=='/gps_tracker_dev_prodreview_20261020'
assert not env.get('FCM_SERVICE_ACCOUNT_PATH') and env.get('GPS_KC_INGEST_ENABLED')=='0'
# This suite waits 25 seconds for failure isolation. Performance clones may
# retain the production 300-second interval; reject that setup before writes.
# The clone API must be restarted with this same environment file.
assert 5 <= int(env.get('GPS_STATS_POLL_SECONDS', '300')) <= 10, \
 'Security regression requires clone GPS_STATS_POLL_SECONDS=5..10 and an API restart with that environment'
db=psycopg2.connect(env['DATABASE_URL']);db.autocommit=True;c=db.cursor()
run=uuid.uuid4().hex;api='/gps-tracker/api/v1';users=[];devices=[];paths=[];streams=[]
started=time.monotonic()

def sql(query,args=()):
 c.execute(query,args);return c.fetchone()[0] if c.description else None

def token(user,ttl=600):
 enc=lambda x:base64.urlsafe_b64encode(json.dumps(x,separators=(',',':')).encode()).rstrip(b'=')
 raw=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'sub':str(user),'iat':int(time.time()),'exp':int(time.time())+ttl,'typ':'access'})
 return (raw+b'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),raw,hashlib.sha256).digest()).rstrip(b'=')).decode()

def request(path,user=None,data=None,method=None,expected=200,headers=None,raw=None):
 headers=dict(headers or {})
 if user:headers['Authorization']='Bearer '+token(user)
 if data is not None:raw=json.dumps(data,separators=(',',':')).encode();headers['Content-Type']='application/json'
 req=urllib.request.Request(base+path,data=raw,method=method,headers=headers)
 try:
  with urllib.request.urlopen(req,timeout=20) as r:status,body=r.status,r.read()
 except urllib.error.HTTPError as e:status,body=e.code,e.read()
 assert status==expected,(path,status,expected,body[:160])
 return json.loads(body) if body[:1] in (b'{',b'[') else body

class Stream:
 def __init__(self,user,device=None,ttl=600):
  self.sock=socket.create_connection(('127.0.0.1',3042),timeout=5);self.file=self.sock.makefile('rb')
  key=base64.b64encode(os.urandom(16)).decode()
  self.sock.sendall((f'GET /gps-tracker/ws/realtime?token={token(user,ttl)} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n\r\n').encode())
  assert b'101' in self.file.readline()
  while self.file.readline()!=b'\r\n':pass
  assert self.read()['type']=='hello'
  if device:
   payload=json.dumps({'action':'subscribe','device_ids':[device]}).encode();mask=os.urandom(4)
   self.sock.sendall(bytes([0x81,0x80|len(payload)])+mask+bytes(v^mask[i%4] for i,v in enumerate(payload)))
   assert self.read()['accepted']==[device]
  streams.append(self)
 def read(self,timeout=3):
  self.sock.settimeout(timeout)
  try:
   head=self.file.read(2)
   if len(head)!=2:return {'type':'closed'}
   opcode=head[0]&15;length=head[1]&127
   if length==126:length=struct.unpack('!H',self.file.read(2))[0]
   elif length==127:length=struct.unpack('!Q',self.file.read(8))[0]
   assert length<200000
   body=self.file.read(length)
   return {'type':'closed'} if opcode==8 else json.loads(body)
  except socket.timeout:return None
 def close(self):
  self.file.close();self.sock.close()

try:
 for suffix in ('a','b'):
  users.append(sql("INSERT INTO users(email,password_hash,phone,display_name,credits) VALUES(%s,'test-only','01000000000','Security regression',10000) RETURNING id",(f'security-{run}-{suffix}@example.invalid',)))
 a,b=users;uid='security-'+run
 did=sql("INSERT INTO devices(device_uid,api_key_hash) VALUES(%s,'') RETURNING id",(uid,));devices.append(did)
 secret=secrets.token_hex(32);key=hashlib.sha256(secret.encode()).digest();counter=0
 sql('INSERT INTO device_credentials(device_id,key_digest) VALUES(%s,%s)',(did,key))
 def signed(data=None,ack=None,pair_code=None):
  global counter
  counter+=1;body={'device_uid':uid,'ts':100,'l80':{'fix':False},**(data or {})}
  if ack:body['command_ack']=ack
  if pair_code:body['pairing_hash']=hashlib.sha256(pair_code.encode()).hexdigest()
  raw=json.dumps(body,separators=(',',':')).encode();signature=hmac.new(key,f'{uid}\n{counter}\n'.encode()+raw,hashlib.sha256).hexdigest()
  headers={'Content-Type':'application/json','X-GPS-UID':uid,'X-GPS-Counter':str(counter),'X-GPS-Signature':signature}
  outer=request('/gps-tracker/ingest',raw=raw,headers=headers)
  expected=hmac.new(key,f'response\n{uid}\n{counter}\n{outer["payload"]}'.encode(),hashlib.sha256).hexdigest()
  assert outer['counter']==counter and hmac.compare_digest(outer['signature'],expected)
  return json.loads(base64.b64decode(outer['payload'])),(raw,headers)
 request('/gps-tracker/ingest',data={'device_uid':'unknown-'+run},expected=401)
 request('/gps-tracker/ingest',data={'device_uid':uid},expected=401)
 code=secrets.token_hex(10);result,saved=signed(pair_code=code)
 assert result['ok']
 request('/gps-tracker/ingest',raw=saved[0],headers=saved[1],expected=409)
 request('/gps-tracker/ingest',raw=saved[0]+b' ',headers=saved[1],expected=401)
 request('/gps-tracker/ingest',data={'device_uid':uid},expected=401)
 print('PASS device signatures, authenticated replies, unknown enrollment rejection, tamper and replay rejection',flush=True)

 request(api+'/devices/scan',a,expected=403)
 request(api+'/devices/pair',a,{'device_uid':uid,'display_name':'Proof needed'},expected=400)
 assert request(api+'/devices/pair',a,{'registration_code':code,'display_name':'Registered test'})['id']==did
 request(api+'/devices/pair',b,{'registration_code':code,'display_name':'Foreign claim'},expected=400)
 print('PASS ordinary scan blocked and one-time registration proof cannot be reused by another account',flush=True)

 legacy='legacy-'+run
 lid=sql("INSERT INTO devices(device_uid,api_key_hash,owner_id,ingest_legacy_allowed) VALUES(%s,'',%s,true) RETURNING id",(legacy,a));devices.append(lid)
 assert request('/gps-tracker/ingest',data={'device_uid':legacy,'l80':{'fix':False}})['ok']
 sql('INSERT INTO device_credentials(device_id,key_digest) VALUES(%s,%s)',(lid,key))
 lc=1;raw=json.dumps({'device_uid':legacy,'l80':{'fix':False}},separators=(',',':')).encode()
 headers={'Content-Type':'application/json','X-GPS-UID':legacy,'X-GPS-Counter':str(lc),'X-GPS-Signature':hmac.new(key,f'{legacy}\n{lc}\n'.encode()+raw,hashlib.sha256).hexdigest()}
 request('/gps-tracker/ingest',raw=raw,headers=headers)
 request('/gps-tracker/ingest',data={'device_uid':legacy},expected=401)
 print('PASS only grandfathered hardware keeps legacy support; first signed upload permanently closes fallback',flush=True)

 phone=request(api+'/devices/pair-phone',a,{'client_uuid':run,'display_name':'Phone auth regression'});devices.append(phone['id'])
 phonebody={'device_uid':phone['device_uid'],'phone':{'fix':True,'lat':37.1,'lng':127.1}}
 request('/gps-tracker/ingest',data=phonebody,expected=401)
 request('/gps-tracker/ingest',b,phonebody,expected=403)
 request('/gps-tracker/ingest',a,phonebody)
 print('PASS phone tracker requires the owning account session',flush=True)

 request(api+f'/devices/{did}',a,{'car_plate':'123가 4567','car_model':'Private model','next_service_date':'2026-12-01'},method='PATCH')
 assert sql('SELECT license_plate=car_plate FROM devices WHERE id=%s',(did,))
 boundary='security-'+run;png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=')
 raw=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n'.encode()+png+f'\r\n--{boundary}--\r\n'.encode())
 image=request(api+f'/devices/{did}/car-image',a,raw=raw,headers={'Content-Type':'multipart/form-data; boundary='+boundary})
 private=Path(env['PRIVATE_UPLOAD_DIR'])/'car-images'/image['url'].rsplit('/',1)[-1];paths.append(private)
 assert private.read_bytes()==png and request(api+f'/devices/{did}/car-image',a)==png
 request(api+f'/devices/{did}/car-image',b,expected=404);request(api+f'/devices/{did}/car-image',expected=401)
 print('PASS canonical vehicle plate and authenticated private image delivery',flush=True)

 contract=sql("INSERT INTO rental_contracts(user_id,device_id,renter_name,starts_at,ends_at) VALUES(%s,%s,'Private renter',now(),now()+interval '1 day') RETURNING id",(a,did))
 def handoff(label,expired=False):
  t=run+label
  sql("INSERT INTO rental_handoff_tokens(contract_id,user_id,purpose,token,expires_at) VALUES(%s,%s,'pickup',%s,now()+(%s)*interval '1 hour') RETURNING id",(contract,a,t,-1 if expired else 1))
  return t
 old=handoff('revoked');assert request(api+'/rentcar/handoff/'+old)['renter_name']=='Private renter'
 sql('UPDATE rental_handoff_tokens SET revoked_at=now() WHERE token=%s',(old,))
 result=request(api+'/rentcar/handoff/'+old,expected=410);assert 'Private renter' not in json.dumps(result)
 request(api+'/rentcar/handoff/'+handoff('expired',True),expected=410)
 retained_token=handoff('transfer')
 print('PASS revoked and expired public links reveal no contract details',flush=True)

 beep=request(api+f'/devices/{did}/beep',a,data={})['command_id']
 reset=request(api+f'/devices/{did}/reset',a,data={})['command_id']
 assert signed()[0]['command_id']==reset and signed()[0]['command_id']==reset
 assert signed(ack=reset)[0]['command_id']==beep
 assert 'command_id' not in signed(ack=beep)[0]
 assert sql('SELECT count(*) FROM device_commands WHERE device_id=%s AND acknowledged_at IS NOT NULL',(did,))==2
 print('PASS reset priority preserves beep, lost responses retry the same command, and acknowledgements complete delivery',flush=True)

 credits=sql('SELECT credits FROM users WHERE id=%s',(a,))
 sql(f"CREATE FUNCTION security_share_failure_{run}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.device_id={did} THEN RAISE EXCEPTION 'security rollback fixture'; END IF; RETURN NEW; END $$")
 sql(f'CREATE TRIGGER security_share_{run} BEFORE INSERT ON share_tokens FOR EACH ROW EXECUTE FUNCTION security_share_failure_{run}()')
 request(api+f'/devices/{did}/shares',a,{'ttl_hours':24},expected=500)
 assert sql('SELECT credits FROM users WHERE id=%s',(a,))==credits
 sql(f'DROP TRIGGER security_share_{run} ON share_tokens');sql(f'DROP FUNCTION security_share_failure_{run}()')
 share=request(api+f'/devices/{did}/shares',a,{'ttl_hours':24});start_expiry=share['expires_at']
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
  results=list(pool.map(lambda _:request(api+f'/shares/{share["id"]}/extend',a,{'extra_hours':24}),range(2)))
 assert sql('SELECT extract(epoch FROM expires_at-%s::timestamptz)::int FROM share_tokens WHERE id=%s',(start_expiry,share['id']))==48*3600
 assert sql('SELECT credits FROM users WHERE id=%s',(a,))==credits-72*5
 print('PASS link creation rollback includes credits and concurrent extensions both preserve purchased time',flush=True)

 old_ws=Stream(a,did)
 sql("INSERT INTO location_records(device_id,user_id,recorded_at,source,fix,lat,lng) VALUES(%s,%s,now()-interval '60 days','l80',true,37,127)",(did,a))
 old_count=sql('SELECT count(*) FROM location_records WHERE device_id=%s AND user_id=%s',(did,a))
 request(api+f'/devices/{did}',a,method='DELETE')
 assert sql('SELECT count(*) FROM location_records WHERE device_id=%s AND user_id=%s',(did,a))==old_count
 request(api+'/rentcar/handoff/'+retained_token,expected=404)
 new_code=secrets.token_hex(10);signed(pair_code=new_code)
 new_device=request(api+'/devices/pair',b,{'registration_code':new_code,'display_name':'New owner'})
 for field in ('car_plate','license_plate','car_model','car_image_url','next_service_date','insurance_expiry','inspection_expiry'):
  assert new_device[field] is None,(field,new_device[field])
 request(api+f'/devices/{did}/car-image',b,expected=404)
 current_ws=Stream(b,did);signed({'l80':{'fix':True,'lat':38.1,'lng':128.1,'sat':8}})
 assert current_ws.read()['type']=='location'
 assert old_ws.read(timeout=1) is None
 expiry_ws=Stream(b,ttl=2);assert expiry_ws.read(timeout=5)=={'type':'closed'}
 print('PASS account transfer clears private fields, revokes handoff links and stops old live subscriptions; JWT expiry closes sockets',flush=True)

 # Exercise the real worker after a deliberate, device-local failure.
 bad=sql("INSERT INTO devices(device_uid,api_key_hash,owner_id) VALUES(%s,'',%s) RETURNING id",('bad-stats-'+run,b));devices.append(bad)
 sql(f"CREATE FUNCTION security_stats_failure_{run}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.device_id={bad} THEN RAISE EXCEPTION 'poison queue fixture'; END IF; RETURN NEW; END $$")
 sql(f'CREATE TRIGGER security_stats_{run} BEFORE INSERT ON daily_stats FOR EACH ROW EXECUTE FUNCTION security_stats_failure_{run}()')
 sql("INSERT INTO stats_rebuild_queue(device_id,date) VALUES(%s,current_date-2),(%s,current_date-1) ON CONFLICT(device_id,date) DO UPDATE SET generation=stats_rebuild_queue.generation+1,next_attempt_at=now()",(bad,did))
 deadline=time.monotonic()+25
 while time.monotonic()<deadline:
  if sql('SELECT count(*) FROM stats_rebuild_queue WHERE device_id=%s AND attempts>0',(bad,)) and not sql('SELECT count(*) FROM stats_rebuild_queue WHERE device_id=%s',(did,)):break
  time.sleep(.5)
 else:raise AssertionError('poison queue prevented independent rebuild')
 print('PASS one failed statistics rebuild is backed off while other jobs complete',flush=True)
 remaining=65-(time.monotonic()-started)
 if remaining>0:time.sleep(remaining)
 assert sql('SELECT count(*) FROM location_records WHERE device_id=%s AND user_id=%s',(did,a))==old_count
 print('PASS retained old owner history survives the actual housekeeping startup run',flush=True)
finally:
 for stream in streams:
  try:stream.close()
  except Exception:pass
 for table,kind in [('share_tokens','share'),('daily_stats','stats')]:
  sql(f'DROP TRIGGER IF EXISTS security_{kind}_{run} ON {table}');sql(f'DROP FUNCTION IF EXISTS security_{kind}_failure_{run}()')
 for device in devices:sql('DELETE FROM devices WHERE id=%s',(device,))
 for user in users:sql('DELETE FROM users WHERE id=%s',(user,))
 for path in paths:path.unlink(missing_ok=True)
 db.close()
