"""SIM-only first enrollment accepts 1NCE/printed suffixes with a recent authenticated hardware sighting."""
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
  users.append(sql("INSERT INTO users(email,password_hash,phone,display_name) VALUES(%s,'test-only','01000000000','Remote report test') RETURNING id",(f'remote-report-{run}-{label}@example.invalid',)))
 a,b=users; sim='89'+str(secrets.randbelow(10**17)).zfill(17)+'1';first=hw()
 assert send(first,sim)['sim_link_required'];did=sql('SELECT id FROM devices WHERE iccid=%s',(sim,));devices.append(did)
 assert pair(sim,a)['id']==did
 endpoint=api+f'/devices/{did}/sleep-report-interval'
 def value():return req(api+f'/devices/{did}',user=a)['sleep_report_interval_s']
 assert value()==86400
 req(api+'/auth/me/prefs',{'other_test':run},a,method='PATCH')
 for seconds in (60,600,86400):
  assert req(endpoint,{'seconds':seconds},a)['sleep_report_interval_s']==seconds
  assert send(first,sim)['device_config']['sleep_report_interval_s']==seconds
 for seconds in (0,59,61,86401,-1):req(endpoint,{'seconds':seconds},a,expected=400)
 for seconds in ('600',600.5,True):req(endpoint,{'seconds':seconds},a,expected=422)
 req(endpoint,{'seconds':600},b,expected=404)
 req(api+'/auth/me/prefs',{'device_runtime':{}},a,method='PATCH',expected=400)
 assert value()==86400 and req(api+'/auth/me/prefs',user=a)['other_test']==run
 req(endpoint,{'seconds':600},a)
 for _ in range(2):assert send(first,sim)['device_config']['sleep_report_interval_s']==600
 sql("UPDATE device_commands SET requested_at=now()-interval '1 day' WHERE device_id=%s",(did,))
 assert send(first,sim)['device_config']['sleep_report_interval_s']==600
 assert req(api+'/devices',user=a)[0]['sleep_report_interval_s']==600
 # A replacement authenticated hardware receives the same SIM-scoped setting.
 replacement=hw();assert send(replacement,sim)['sim_link_required'];assert pair(sim,a)['id']==did
 assert send(replacement,sim)['device_config']['sleep_report_interval_s']==600
 # Unlink retains past data/settings for this owner but cannot let it control a new owner.
 req(api+f'/devices/{did}',user=a,method='DELETE');req(endpoint,{'seconds':3600},a,expected=404)
 assert send(replacement,sim)['sim_link_required'];assert pair(sim,b)['id']==did
 assert send(replacement,sim)['device_config']['sleep_report_interval_s']==86400
 req(endpoint,{'seconds':600},a,expected=404)
 assert req(endpoint,{'seconds':3600},b)['sleep_report_interval_s']==3600
 assert send(replacement,sim)['device_config']['sleep_report_interval_s']==3600
 print('PASS default and bounded interval, ownership, protected preferences, durable signed response, SIM hardware replacement and owner isolation',flush=True)
finally:
 for uid in hardware:sql('DELETE FROM hardware_credentials WHERE auth_uid=%s',(uid,))
 for id in devices:sql('DELETE FROM devices WHERE id=%s',(id,))
 for id in users:sql('DELETE FROM users WHERE id=%s',(id,))
 db.close()
