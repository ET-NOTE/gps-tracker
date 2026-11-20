"""Validate and deploy daily sleep heartbeat policy; no schema or production data writes."""
import hashlib,json,os,pathlib,re,shutil,subprocess,sys,tarfile,time,urllib.parse,urllib.request
import psycopg2

mode,release,commit=sys.argv[1:4]
assert mode in ('validate','promote')
assert re.fullmatch(r'dev-20261021-\d{6}-[0-9a-f]{7}',release) and re.fullmatch('[0-9a-f]{40}',commit)
stage=pathlib.Path('/home/mmm/gps-artifacts')/release
m=json.loads((stage/'manifest.json').read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
run=lambda args:subprocess.run(args,check=True)
assert m['release']==release and m['git_commit']==commit
assert sha(stage/'gps-tracker-api-dev')==m['api_sha256'] and sha(stage/'source.tar.gz')==m['source_sha256']
for name,h in m['web_files'].items():assert sha(stage/'web'/name)==h
os.umask(0o077)

def cfg(path):
 return dict((k,v.strip().strip('"').strip("'")) for k,v in (line.split('=',1) for line in path.read_text().splitlines() if '=' in line and not line.startswith('#')))

def get(path,local=False):
 with urllib.request.urlopen(('http://127.0.0.1:3042' if local else 'https://gps.serial.kr')+path,timeout=20) as r:return r.read()

def health(local=False,expected=None):
 for _ in range(25):
  try:
   h=json.loads(get('/gps-tracker/health' if local else '/health',local))
   if h['ok'] and h['db'] and (not expected or h['release']==expected):return h
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('health check failed')

validation_env=pathlib.Path('/home/mmm/backups/gps-sim-first-20261020/validation.env')
if mode=='validate':
 c=cfg(validation_env)
 assert urllib.parse.urlsplit(c['DATABASE_URL']).path=='/gps_tracker_dev_prodreview_20261020'
 assert c['BIND_ADDR']=='127.0.0.1:3042' and c['APP_ENV']=='test'
 for k in ('OPENAI_API_KEY','KAKAO_REST_API_KEY','FCM_SERVICE_ACCOUNT_PATH','TOSS_SECRET_KEY','ONCE_API_TOKEN','ONCE_API_CLIENT_SECRET'):assert not c.get(k)
 assert not any((p/'.env').exists() for p in (stage,*stage.parents))
 import socket
 with socket.socket() as s:assert s.connect_ex(('127.0.0.1',3042))!=0
 unit='gps-daily-heartbeat-review'
 try:
  run(['systemd-run','--collect','--unit='+unit,'-p','User=mmm','-p','Group=mmm','-p','EnvironmentFile='+str(validation_env),'-p','WorkingDirectory='+str(stage),str(stage/'gps-tracker-api-dev')])
  health(True,release)
  tests=('test_daily_heartbeat.py','test_dev_api.py','test_sim_first_registration.py')
  for name in tests:run(['python3',str(stage/name),str(validation_env),'http://127.0.0.1:3042'])
  (stage/'daily-validation.json').write_text(json.dumps({'api_sha256':m['api_sha256'],'tests':tests}))
 finally:subprocess.run(['systemctl','stop',unit],check=False)
 sys.exit(0)

assert json.loads((stage/'daily-validation.json').read_text())['api_sha256']==m['api_sha256']
api=pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
web=pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
env=pathlib.Path('/home/mmm/projects/gps-tracker-api/.env');nginx=pathlib.Path('/etc/nginx/sites-available/gps.serial.kr')
assert sha(api)=='f78823387383daecd39c6191109830ba7c2765cbedd8bc33293636382f7ea868'
assert json.loads((web/'version.json').read_text())['git_commit']=='429463056475b57fdd2f3abba0198fbf434a016e'
c=cfg(env)
with psycopg2.connect(c['DATABASE_URL']) as db:
 db.set_session(readonly=True,autocommit=True)
 with db.cursor() as cur:
  cur.execute("SELECT version,encode(checksum,'hex') FROM _sqlx_migrations WHERE success ORDER BY version");applied=dict(cur.fetchall())
  cur.execute('SELECT device_id,count(*) FROM location_records WHERE device_id IN(3163,3005,3018) GROUP BY device_id');before=dict(cur.fetchall())
with tarfile.open(stage/'source.tar.gz') as t:
 embedded={int(pathlib.PurePosixPath(f.name).name.split('_')[0]):hashlib.sha384(t.extractfile(f).read()).hexdigest() for f in t.getmembers() if f.isfile() and f.name.startswith('gps-tracker-api/migrations/') and f.name.endswith('.sql')}
assert applied==embedded and max(applied)==72
backup=pathlib.Path('/home/mmm/backups')/('daily-heartbeat-'+release);backup.mkdir()
baseline=dict(api_sha256=sha(api),web=str(web.resolve()),env_sha256=sha(env),nginx_sha256=sha(nginx),health=health(),records=before)
(backup/'baseline.json').write_text(json.dumps(baseline,indent=2));shutil.copy2(api,backup/'api.previous')
with tarfile.open(backup/'web.previous.tar.gz','w:gz') as t:t.add(web.resolve(),arcname='web')
assert sha(backup/'api.previous')==baseline['api_sha256']
target=pathlib.Path('/home/mmm/releases')/release.replace('dev-','prod-',1);target.mkdir()
shutil.copytree(stage/'web',target/'web')
for p in (web/'assets').iterdir():
 if p.is_file() and not (target/'web/assets'/p.name).exists():shutil.copy2(p,target/'web/assets'/p.name)
(target/'web/uploads').symlink_to(pathlib.Path(c.get('UPLOAD_DIR','/home/mmm/uploads')),target_is_directory=True)
(target/'web/version.json').write_text(json.dumps(dict(m,target='production'),indent=2))
for name in ('source.tar.gz','manifest.json','daily-validation.json'):shutil.copy2(stage/name,target/name)
target.chmod(0o755)
for p in target.rglob('*'):
 if not p.is_symlink():p.chmod(0o755 if p.is_dir() else 0o644)
nextapi=api.with_name('gps-tracker-api.next-daily');nextweb=web.with_name('dist-root.next-daily')
assert not nextapi.exists() and not nextweb.exists() and not nextweb.is_symlink()
try:
 shutil.copy2(stage/'gps-tracker-api-dev',nextapi);nextapi.chmod(0o755);os.replace(nextapi,api)
 run(['systemctl','restart','gps-tracker-api']);health(expected=release)
 nextweb.symlink_to(target/'web',target_is_directory=True);os.replace(nextweb,web)
 assert json.loads(get('/version.json'))['git_commit']==commit
 for name,h in m['web_files'].items():assert hashlib.sha256(get('/'+name)).hexdigest()==h
 assert sha(env)==baseline['env_sha256'] and sha(nginx)==baseline['nginx_sha256']
 with psycopg2.connect(c['DATABASE_URL']) as db:
  with db.cursor() as cur:
   cur.execute('SELECT device_id,count(*) FROM location_records WHERE device_id IN(3163,3005,3018) GROUP BY device_id');after=dict(cur.fetchall())
 assert all(after[k]>=v for k,v in before.items())
 result=dict(release=release,commit=commit,schema_unchanged=72,api_sha256=sha(api),backup=str(backup),records_preserved=True)
 (target/'deployment.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
except Exception:
 shutil.copy2(backup/'api.previous',nextapi);nextapi.chmod(0o755);os.replace(nextapi,api)
 if nextweb.is_symlink():nextweb.unlink()
 nextweb.symlink_to(baseline['web'],target_is_directory=True);os.replace(nextweb,web)
 run(['systemctl','restart','gps-tracker-api']);health(expected=baseline['health']['release'])
 raise
