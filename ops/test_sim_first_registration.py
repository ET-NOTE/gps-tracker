"""SIM-only first enrollment requires full ICCID and a recent authenticated hardware sighting."""
import base64,hashlib,hmac,json,pathlib,secrets,sys,time,urllib.request,urllib.error,urllib.parse,uuid
import psycopg2
envpath,base=sys.argv[1:3];assert base=='http://127.0.0.1:3042'
env={k:v.strip().strip('"').strip("'") for k,v in (line.split('=',1) for line in pathlib.Path(envpath).read_text().splitlines() if '=' in line and not line.startswith('#'))}
assert urllib.parse.urlsplit(env['DATABASE_URL']).path=='/gps_tracker_dev_prodreview_20261020'
db=psycopg2.connect(env['DATABASE_URL']);db.autocommit=True;c=db.cursor();run=uuid.uuid4().hex;users=[];devices=[];hardware=[];api='/gps-tracker/api/v1'
def sql(q,args=()):
 c.execute(q,args);return c.fetchone()[0] if c.description else None
def token(user):
 enc=lambda x:base64.urlsafe_b64encode(json.dumps(x).encode()).rstrip(b'=')
 raw=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'sub':str(user),'typ':'access','iat':int(time.time()),'exp':int(time.time())+600})
 return (raw+b'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),raw,hashlib.sha256).digest()).rstrip(b'=')).decode()
def req(path,data=None,user=None,headers=None,raw=None,expected=200,method=None):
 headers=dict(headers or {})
 if user:headers['Authorization']='Bearer '+token(user)
 if data is not None:raw=json.dumps(data,separators=(',',':')).encode();headers['Content-Type']='application/json'
 try:
  with urllib.request.urlopen(urllib.request.Request(base+path,data=raw,headers=headers,method=method),timeout=20) as r:status,body=r.status,r.read()
 except urllib.error.HTTPError as e:status,body=e.code,e.read()
 assert status==expected,(path,status,expected,body[:200]);return json.loads(body)
def hw():
 uid='first-hw-'+run+'-'+str(len(hardware));key=secrets.token_bytes(32)
 sql('INSERT INTO hardware_credentials(auth_uid,key_digest) VALUES(%s,%s)',(uid,key));hardware.append(uid)
 return dict(uid=uid,key=key,counter=0)
def send(h,sim):
 h['counter']+=1;n=h['counter'];raw=json.dumps({'device_uid':'sim-'+sim[-8:],'iccid':sim,'pairing_hash':hashlib.sha256(run.encode()).hexdigest(),'l80':{'fix':False}},separators=(',',':')).encode()
 headers={'Content-Type':'application/json','X-GPS-Auth-Version':'2','X-GPS-UID':h['uid'],'X-GPS-Counter':str(n),'X-GPS-Signature':hmac.new(h['key'],f"{h['uid']}\n{n}\n".encode()+raw,hashlib.sha256).hexdigest()}
 r=req('/gps-tracker/ingest',headers=headers,raw=raw);assert hmac.compare_digest(r['signature'],hmac.new(h['key'],f"response\n{h['uid']}\n{n}\n{r['payload']}".encode(),hashlib.sha256).hexdigest())
 return json.loads(base64.b64decode(r['payload']))
def pair(sim,user,expected=200):return req(api+'/devices/pair',{'iccid':sim,'display_name':'SIM only first'},user,expected=expected)
try:
 for label in ('a','b'):
  users.append(sql("INSERT INTO users(email,password_hash,phone,display_name) VALUES(%s,'test-only','01000000000','First SIM test') RETURNING id",(f'first-sim-{run}-{label}@example.invalid',)))
 a,b=users;sim='89'+str(secrets.randbelow(10**17)).zfill(17);first=hw()
 assert send(first,sim)['sim_link_required'];did=sql('SELECT id FROM devices WHERE iccid=%s',(sim,));devices.append(did)
 pair(sim[-8:],a,400);assert pair(sim,a)['id']==did
 assert send(first,sim)['ok'] and pair(sim[-8:],a)['id']==did
 pair(sim,b,409)
 print('PASS first device enrolls using SIM and name only; short first claims rejected; existing owner suffix and foreign owner protection retained',flush=True)
 replacement=hw();assert send(replacement,sim)['sim_link_required'];assert pair(sim,a)['id']==did;assert send(replacement,sim)['ok']
 assert pair(sim,a)['id']==did # Multiple previously approved hardware must not block owner lookup.
 before=sql('SELECT count(*) FROM location_records WHERE device_id=%s AND user_id=%s',(did,a))
 req(api+f'/devices/{did}',user=a,method='DELETE')
 assert send(replacement,sim)['sim_link_required'];assert pair(sim,b)['id']==did;assert send(replacement,sim)['ok']
 assert sql('SELECT count(*) FROM location_records WHERE device_id=%s AND user_id=%s',(did,a))==before
 assert send(first,sim)['sim_link_required']
 print('PASS SIM-only replacement and released SIM reuse preserve logical ID and prior records while blocking old account hardware',flush=True)
 # Unknown and stale hardware cannot create a claimable SIM merely by entering a number.
 second_sim='88'+sim[2:];stale=hw();send(stale,second_sim);ds=sql('SELECT id FROM devices WHERE iccid=%s',(second_sim,));devices.append(ds)
 sql("UPDATE hardware_credentials SET last_seen_at=now()-interval '6 minutes' WHERE auth_uid=%s",(stale['uid'],));pair(second_sim,b,400)
 send(stale,second_sim);extra=hw();send(extra,second_sim);pair(second_sim,b,400)
 sql("UPDATE hardware_credentials SET last_seen_at=now()-interval '6 minutes' WHERE auth_uid=%s",(extra['uid'],));assert pair(second_sim,b)['id']==ds
 print('PASS stale or ambiguous authenticated sightings cannot be claimed; one current hardware is required',flush=True)
 # Independent fixtures verify the account attempt limit without exhausting success cases.
 sql('DELETE FROM device_pair_attempts WHERE user_id=%s',(a,))
 for _ in range(10):req(api+'/devices/pair',{'iccid':'1234567890123456789','display_name':'Attempt limit'},a,expected=400)
 req(api+'/devices/pair',{'iccid':'1234567890123456789','display_name':'Attempt limit'},a,expected=429)
 print('PASS first-registration attempts are rate limited',flush=True)
finally:
 for uid in hardware:sql('DELETE FROM hardware_credentials WHERE auth_uid=%s',(uid,))
 for id in devices:sql('DELETE FROM devices WHERE id=%s',(id,))
 for id in users:sql('DELETE FROM users WHERE id=%s',(id,))
 db.close()
