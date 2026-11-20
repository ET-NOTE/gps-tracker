"""SIM continuity across independent hardware keys; private clone only."""
import base64,concurrent.futures,hashlib,hmac,json,pathlib,secrets,sys,time,urllib.request,urllib.error,urllib.parse,uuid
import psycopg2
envpath,base=sys.argv[1:3]
assert base=='http://127.0.0.1:3042'
env={k:v.strip().strip('"').strip("'") for k,v in (line.split('=',1) for line in pathlib.Path(envpath).read_text().splitlines() if '=' in line and not line.startswith('#'))}
assert urllib.parse.urlsplit(env['DATABASE_URL']).path=='/gps_tracker_dev_prodreview_20261020'
db=psycopg2.connect(env['DATABASE_URL']);db.autocommit=True;c=db.cursor()
run=uuid.uuid4().hex;users=[];devices=[];hardware=[];api='/gps-tracker/api/v1'
def sql(q,args=()):
 c.execute(q,args);return c.fetchone()[0] if c.description else None
def jwt(user):
 enc=lambda x:base64.urlsafe_b64encode(json.dumps(x).encode()).rstrip(b'=')
 raw=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'sub':str(user),'typ':'access','iat':int(time.time()),'exp':int(time.time())+600})
 return (raw+b'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),raw,hashlib.sha256).digest()).rstrip(b'=')).decode()
def request(path,data=None,user=None,headers=None,raw=None,expected=200,method=None):
 headers=dict(headers or {})
 if user:headers['Authorization']='Bearer '+jwt(user)
 if data is not None:raw=json.dumps(data,separators=(',',':')).encode();headers['Content-Type']='application/json'
 try:
  with urllib.request.urlopen(urllib.request.Request(base+path,data=raw,headers=headers,method=method),timeout=20) as r:status,body=r.status,r.read()
 except urllib.error.HTTPError as e:status,body=e.code,e.read()
 assert status==expected,(path,status,expected,body[:200])
 return json.loads(body) if body else None
def credential(owner):
 auth='hw-'+run+'-'+str(len(hardware));key=secrets.token_bytes(32)
 sql('INSERT INTO hardware_credentials(auth_uid,key_digest,authorized_owner_id) VALUES(%s,%s,%s)',(auth,key,owner));hardware.append(auth)
 return {'uid':auth,'key':key,'counter':0}
def send(hw,sim,code=None,expected=200,imei='111111111111111'):
 hw['counter']+=1;n=hw['counter']
 raw=json.dumps({'device_uid':'sim-'+sim[-8:],'iccid':sim,'imei':imei,'vbat_mv':4000,'l80':{'fix':True,'lat':37.1,'lng':127.1,'sat':8},'pairing_hash':hashlib.sha256((code or secrets.token_hex(10)).encode()).hexdigest()},separators=(',',':')).encode()
 headers={'Content-Type':'application/json','X-GPS-Auth-Version':'2','X-GPS-UID':hw['uid'],'X-GPS-Counter':str(n),'X-GPS-Signature':hmac.new(hw['key'],f"{hw['uid']}\n{n}\n".encode()+raw,hashlib.sha256).hexdigest()}
 out=request('/gps-tracker/ingest',raw=raw,headers=headers,expected=expected)
 if expected!=200:return out
 assert out['counter']==n
 signed=f"response\n{hw['uid']}\n{n}\n{out['payload']}".encode()
 assert hmac.compare_digest(out['signature'],hmac.new(hw['key'],signed,hashlib.sha256).hexdigest())
 hw['last']=(raw,headers)
 return json.loads(base64.b64decode(out['payload']))
def count(id):return sql('SELECT count(*) FROM location_records WHERE device_id=%s',(id,))
def pair(sim,code,user,expected=200):return request(api+'/devices/pair',{'iccid':sim,'registration_code':code,'display_name':'SIM continuity'},user,expected=expected)
try:
 for label in ('a','b'):
  users.append(sql("INSERT INTO users(email,password_hash,phone,display_name) VALUES(%s,'test-only','01000000000','SIM test') RETURNING id",(f'sim-{run}-{label}@example.invalid',)))
 a,b=users
 prefix='89'+str(secrets.randbelow(10**13)).zfill(13)
 sims=[prefix+str(i).zfill(4) for i in (1,2,3,4)]
 for sim,owner in zip(sims[:2],(a,b)):
  devices.append(sql("INSERT INTO devices(device_uid,iccid,owner_id,api_key_hash,ingest_legacy_allowed) VALUES(%s,%s,%s,'',true) RETURNING id",('logical-'+run+sim[-1],sim,owner)))
 da,dbid=devices;first=credential(a);second=credential(a);fresh=credential(None)
 assert send(first,sims[0])['ok'];before=count(da)
 assert send(second,sims[0],imei='222222222222222')['ok'] and count(da)==before+1
 assert sql('SELECT active_auth_uid FROM devices WHERE id=%s',(da,))==second['uid']
 assert sql('SELECT device_uid FROM devices WHERE id=%s',(da,))=='logical-'+run+'1'
 assert sql("SELECT count(*) FROM device_audit_log WHERE device_id=%s AND event_type='sim_swap'",(da,))>=1
 assert sql('SELECT count(DISTINCT device_id) FROM location_records WHERE device_id=%s',(da,))==1
 request('/gps-tracker/ingest',raw=second['last'][0],headers=second['last'][1],expected=409)
 request('/gps-tracker/ingest',raw=second['last'][0]+b' ',headers=second['last'][1],expected=401)
 request('/gps-tracker/ingest',data={'device_uid':'logical-'+run+'1','iccid':sims[0]},expected=401)
 concurrent_before=count(da)
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
  assert all(out['ok'] for out in pool.map(lambda hw:send(hw,sims[0]),(first,second)))
 assert count(da)==concurrent_before+2
 print('PASS two hardware keys append to the same SIM device/history; modem changes audited; signatures, replay and downgrade protection',flush=True)
 old=count(dbid);foreigncode=secrets.token_hex(10)
 assert send(first,sims[1],foreigncode)['sim_link_required'] and count(dbid)==old
 pair(sims[1],foreigncode,a,409)
 pair(sims[0],foreigncode,a,400)
 assert count(dbid)==old
 print('PASS foreign SIM cannot receive telemetry or transfer ownership; SIM and physical proof must match',flush=True)
 newunit=credential(None);newunitcode=secrets.token_hex(10);existing=count(da)
 assert send(newunit,sims[0],newunitcode)['sim_link_required'] and count(da)==existing
 assert pair(sims[0],newunitcode,a)['id']==da
 assert send(newunit,sims[0])['ok'] and count(da)==existing+1
 print('PASS previously unassigned replacement hardware joins an owned SIM with owner confirmation and retains its original device ID',flush=True)
 code=secrets.token_hex(10)
 assert send(fresh,sims[2],code)['sim_link_required']
 dc=sql('SELECT id FROM devices WHERE iccid=%s',(sims[2],));devices.append(dc)
 assert count(dc)==0
 assert pair(sims[2][-8:],code,a)['id']==dc
 assert pair(sims[2]+'0',code,a)['id']==dc
 assert send(fresh,sims[2])['ok'] and count(dc)==1
 assert request(api+'/devices/pair',{'iccid':sims[2],'display_name':'SIM input main'},a)['id']==dc
 print('PASS SIM-first enrollment with separate hardware proof; short/full/printed SIM forms resolve one logical device',flush=True)
 # The same hardware changes SIM: no record goes back to its former SIM.
 oldc=count(dc);olda=count(da)
 assert send(fresh,sims[0])['ok'] and count(da)==olda+1 and count(dc)==oldc
 print('PASS one hardware switches SIM without mixing their histories',flush=True)
 # Full ICCID disambiguates SIMs even when their user-facing final eight digits collide.
 collision='88'+sims[0][2:]
 collision_id=sql("INSERT INTO devices(device_uid,iccid,owner_id,api_key_hash) VALUES(%s,%s,%s,'') RETURNING id",('collision-'+run,collision,a));devices.append(collision_id)
 request(api+'/devices/pair',{'iccid':sims[0][-8:],'display_name':'Ambiguous SIM'},a,expected=400)
 assert request(api+'/devices/pair',{'iccid':sims[0],'display_name':'Full SIM'},a)['id']==da
 assert send(first,collision)['ok'] and count(collision_id)==1
 print('PASS concurrent hardware uploads serialize safely; colliding SIM suffixes require the full number',flush=True)
 # Unpair and re-pair: preserve records and require a fresh proof after unlink.
 oldcode=secrets.token_hex(10);send(fresh,sims[0],oldcode)
 retained=count(da)
 request(api+f'/devices/{da}',user=a,method='DELETE')
 assert count(da)==retained and sql('SELECT owner_id FROM devices WHERE id=%s',(da,)) is None
 request('/gps-tracker/ingest',data={'device_uid':'logical-'+run+'1','iccid':sims[0]},expected=401)
 pair(sims[0],oldcode,b,400)
 newcode=secrets.token_hex(10);assert send(fresh,sims[0],newcode)['sim_link_required']
 assert pair(sims[0],newcode,b)['id']==da
 assert send(fresh,sims[0])['ok']
 blocked=count(da);assert send(first,sims[0])['sim_link_required'] and count(da)==blocked
 history=request(api+f'/devices/{da}/locations?limit=10',user=b)
 assert len(history)==1,history
 assert sql('SELECT count(*) FROM location_records WHERE device_id=%s AND user_id=%s',(da,a))==retained
 print('PASS unpair preserves history, old confirmation expires, owner transfer blocks prior hardware and hides prior owner history',flush=True)
finally:
 for uid in hardware:sql('DELETE FROM hardware_credentials WHERE auth_uid=%s',(uid,))
 for id in devices:sql('DELETE FROM devices WHERE id=%s',(id,))
 for id in users:sql('DELETE FROM users WHERE id=%s',(id,))
 db.close()
