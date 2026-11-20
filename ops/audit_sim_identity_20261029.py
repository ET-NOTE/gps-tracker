"""Read production identity flags; exercise SIM continuity only in the private clone."""
import hashlib,json,pathlib,socket,subprocess,time,urllib.request,urllib.parse
import psycopg2

stage=pathlib.Path('/home/mmm/gps-artifacts/corporate-feedback-20261029-c7b7fa2')
prod=pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def cfg(p):
 return {k:v.strip().strip('"').strip("'") for k,v in (l.split('=',1) for l in p.read_text().splitlines() if '=' in l and not l.startswith('#'))}
c=cfg(pathlib.Path('/home/mmm/projects/gps-tracker-api/.env'))
result={'production_api_sha256':sha(prod),'compatibility_flags':{k:c.get(k) in ('1','true') for k in ('GPS_LEGACY_INGEST_ENABLED','GPS_KC_INGEST_ENABLED')}}
with psycopg2.connect(c['DATABASE_URL']) as db:
 db.set_session(readonly=True,autocommit=True)
 with db.cursor() as cur:
  cur.execute("SELECT count(*),count(*) FILTER (WHERE device_kind='phone'),count(*) FILTER (WHERE ingest_legacy_allowed),count(*) FILTER (WHERE active_auth_uid IS NOT NULL) FROM devices")
  result['device_counts']=dict(zip(('total','phone','legacy_allowed','hardware_v2'),cur.fetchone()))
envpath=pathlib.Path('/home/mmm/backups/gps-sim-first-20261020/validation.env');c=cfg(envpath)
assert urllib.parse.urlsplit(c['DATABASE_URL']).path=='/gps_tracker_dev_prodreview_20261020'
assert c['BIND_ADDR']=='127.0.0.1:3042' and c['APP_ENV']=='test'
for key in ('OPENAI_API_KEY','KAKAO_REST_API_KEY','FCM_SERVICE_ACCOUNT_PATH','TOSS_SECRET_KEY','ONCE_API_TOKEN','ONCE_API_CLIENT_SECRET'):assert not c.get(key)
assert sha(stage/'gps-tracker-api')==sha(prod)
with socket.socket() as s:assert s.connect_ex(('127.0.0.1',3042))!=0
unit='gps-sim-continuity-review'
try:
 subprocess.run(['systemd-run','--collect','--unit='+unit,'-p','User=mmm','-p','Group=mmm','-p','EnvironmentFile='+str(envpath),'-p','WorkingDirectory='+str(stage),'-p','MemoryMax=500M',str(stage/'gps-tracker-api')],check=True)
 for _ in range(30):
  try:
   with urllib.request.urlopen('http://127.0.0.1:3042/gps-tracker/health',timeout=5) as r:h=json.load(r)
   if h['ok'] and h['db']:break
  except Exception:pass
  time.sleep(1)
 else:raise RuntimeError('clone health failed')
 for script in ('test_sim_hardware.py','test_sim_first_registration.py'):
  subprocess.run(['python3',str(stage/script),str(envpath),'http://127.0.0.1:3042'],check=True)
 result['clone_sim_regressions']='passed'
finally:subprocess.run(['systemctl','stop',unit],check=False)
assert sha(prod)==result['production_api_sha256']
print(json.dumps(result))
