"""Settings smoke test on the disposable clone only; no production tokens."""
import base64,hashlib,hmac,json,pathlib,secrets,sys,time,urllib.request,urllib.parse,uuid
import psycopg2
envpath,base=sys.argv[1:3]
assert base=='http://127.0.0.1:3042'
env={k:v.strip().strip('"').strip("'") for k,v in (line.split('=',1) for line in pathlib.Path(envpath).read_text().splitlines() if '=' in line and not line.startswith('#'))}
assert urllib.parse.urlsplit(env['DATABASE_URL']).path=='/gps_tracker_dev_prodreview_20261020'
db=psycopg2.connect(env['DATABASE_URL']);db.autocommit=True;c=db.cursor();user=None
try:
 c.execute("INSERT INTO users(email,password_hash,phone,display_name) VALUES(%s,'test-only','01000000000','Daily report test') RETURNING id",('daily-'+uuid.uuid4().hex+'@example.invalid',));user=c.fetchone()[0]
 enc=lambda x:base64.urlsafe_b64encode(json.dumps(x).encode()).rstrip(b'=')
 raw=enc({'alg':'HS256','typ':'JWT'})+b'.'+enc({'sub':str(user),'typ':'access','iat':int(time.time()),'exp':int(time.time())+600})
 token=(raw+b'.'+base64.urlsafe_b64encode(hmac.new(env['JWT_SECRET'].encode(),raw,hashlib.sha256).digest()).rstrip(b'=')).decode()
 def req(value=None):
  data=None if value is None else json.dumps(value).encode()
  with urllib.request.urlopen(urllib.request.Request(base+'/gps-tracker/api/v1/notifications/settings',data=data,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='GET' if value is None else 'PATCH'),timeout=15) as r:return json.load(r)
 first=req();assert first['offline_minutes']==1440
 for enabled in (True,False):
  result=req({'wake_alert':enabled});assert result['wake_alert']==enabled and req()['wake_alert']==enabled
  assert result['motion_alert']==first['motion_alert'] and result['sleep_alert']==first['sleep_alert']
 print('PASS default 24h connection alert and persisted status-report notification ON/OFF; motion and sleep settings preserved')
finally:
 if user:c.execute('DELETE FROM users WHERE id=%s',(user,))
 db.close()
