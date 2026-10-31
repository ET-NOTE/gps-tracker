"""Guarded location/trip query release: schema 80; no production trip annotation is written."""
import hashlib,json,os,pathlib,shutil,subprocess,sys,tarfile,time,urllib.parse,urllib.request
import psycopg2
mode=sys.argv[1]; assert mode in ('validate','promote')
stage=pathlib.Path('/home/mmm/gps-artifacts/location-query-20261031-r1')
m=json.loads((stage/'manifest.json').read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
run=lambda a:subprocess.run(a,check=True)
assert sha(stage/'gps-tracker-api')==m['api_sha256'] and sha(stage/'web.tar.gz')==m['archive_sha256'] and sha(stage/'source-final.tar.gz')==m['source_sha256']
with tarfile.open(stage/'web.tar.gz') as archive:
 index=next(f for f in archive.getmembers() if f.isfile() and f.name.removeprefix('./')=='index.html')
 assert b'"/assets/' in archive.extractfile(index).read(), 'Production requires VITE_BASE=/'
os.umask(0o077)
def cfg(p):
 return {k:v.strip().strip(chr(34)).strip(chr(39)) for k,v in (l.split('=',1) for l in p.read_text().splitlines() if '=' in l and not l.startswith('#'))}
def get(path,local=False):
 with urllib.request.urlopen(('http://127.0.0.1:3042' if local else 'https://gps.serial.kr')+path,timeout=20) as r:return r.read()
def health(local=False,expected=None):
 for _ in range(30):
  try:
   h=json.loads(get('/gps-tracker/health' if local else '/health',local))
   if h['ok'] and h['db'] and (not expected or h['release']==expected):return h
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('Health failed')
validation_env=pathlib.Path('/home/mmm/backups/gps-sim-first-20261020/validation.env')
if mode=='validate':
 c=cfg(validation_env)
 assert urllib.parse.urlsplit(c['DATABASE_URL']).path=='/gps_tracker_dev_prodreview_20261020'
 assert c['BIND_ADDR']=='127.0.0.1:3042' and c['APP_ENV']=='test'
 for key in ('OPENAI_API_KEY','KAKAO_REST_API_KEY','FCM_SERVICE_ACCOUNT_PATH','TOSS_SECRET_KEY','ONCE_API_TOKEN','ONCE_API_CLIENT_SECRET'):assert not c.get(key)
 import socket
 with socket.socket() as s:assert s.connect_ex(('127.0.0.1',3042))!=0
 assert not any((p/'.env').exists() for p in (stage,*stage.parents))
 run(['python3',str(stage/'test_location_queries.py'),str(validation_env)])
 unit='gps-location-query-review'
 try:
  (stage/'gps-tracker-api').chmod(0o755)
  run(['systemd-run','--collect','--unit='+unit,'-p','User=mmm','-p','Group=mmm','-p','EnvironmentFile='+str(validation_env),'-p','WorkingDirectory='+str(stage),'-p','MemoryMax=500M','--setenv=UPLOAD_DIR='+str(stage/'uploads'),'--setenv=PRIVATE_UPLOAD_DIR='+str(stage/'private'),str(stage/'gps-tracker-api')])
  health(True,m['api_release'])
  for script in ('test_dev_speed.py','test_fleet_trip_quality.py','test_fleet_trip_assignment.py','test_fleet_expenses.py','test_fleet_sites.py','test_fleet_team.py','test_fleet_assets.py','test_corporate_template.py','test_corporate_coverage.py','test_business_api.py','test_sim_hardware.py','test_sim_first_registration.py'):run(['python3',str(stage/script),str(validation_env),'http://127.0.0.1:3042'])
  (stage/'validation.json').write_text(json.dumps({'api_sha256':m['api_sha256'],'query_equivalence_checks':34,'quality_checks':29,'assignment_checks':25,'expense_checks':31,'fleet_sites_checks':23,'fleet_team_checks':33,'fleet_asset_checks':25,'coverage_checks':8,'business_read_regression':True,'xlsx_template_and_tenant_filters':True,'sim_identity_regressions':True}))
 finally:subprocess.run(['systemctl','stop',unit],check=False)
 sys.exit(0)
assert json.loads((stage/'validation.json').read_text())['api_sha256']==m['api_sha256']
def disk_guard():
 # disk_usage uses unprivileged available blocks: root-reserved space cannot
 # support PostgreSQL writes even when deployment itself runs as root.
 for path in (stage,pathlib.Path('/var/lib/postgresql')):
  assert shutil.disk_usage(path).free >= 1024**3, 'At least 1 GiB free is required before production changes: '+str(path)
disk_guard()
api=pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
web=pathlib.Path('/home/mmm/gps-tracker-web/dist-root'); env=pathlib.Path('/home/mmm/projects/gps-tracker-api/.env'); nginx=pathlib.Path('/etc/nginx/sites-available/gps.serial.kr')
assert sha(api)=='829e6d9351aeab2a128cc610a69847aa5ab82d184b8a53310ef7693360f4fae3'
assert json.loads((web/'version.json').read_text())['git_commit']=='114110bc0e796732f0db3eb6cc75331aee269794'
c=cfg(env)
with psycopg2.connect(c['DATABASE_URL']) as db:
 db.set_session(readonly=True,autocommit=True)
 with db.cursor() as cur:
  cur.execute("SELECT version,encode(checksum,'hex') FROM _sqlx_migrations WHERE success ORDER BY version"); applied=dict(cur.fetchall())
with tarfile.open(stage/'source-final.tar.gz') as t:
 embedded={int(pathlib.PurePosixPath(f.name).name.split('_')[0]):hashlib.sha384(t.extractfile(f).read()).hexdigest() for f in t.getmembers() if f.isfile() and f.name.startswith('gps-tracker-api/migrations/') and f.name.endswith('.sql')}
assert applied=={v:h for v,h in embedded.items() if v<=79} and max(applied)==79 and set(embedded)-set(applied)=={80}

# Explicitly guard the neighboring services and deployments.
def neighbors():
 return {'dev_api':sha(pathlib.Path('/home/gps-dev/projects/gps-tracker-api/bin/gps-tracker-api-dev')),
         'dev_web':str(pathlib.Path('/home/gps-dev/gps-tracker-web-dev/dist').resolve()),
         'shield':str(pathlib.Path('/srv/shield/current').resolve()),
         'processes':subprocess.check_output(['systemctl','show','gps-tracker-api-dev','shield-api','-p','MainPID','-p','ActiveEnterTimestamp']).decode()}
other=neighbors()
backup=pathlib.Path('/home/mmm/backups/location-query-20261031-r1');backup.mkdir()
baseline={'api_sha256':sha(api),'web':str(web.resolve()),'env_sha256':sha(env),'nginx_sha256':sha(nginx),'health':health(),'neighbors':other}
# A complete pg_dump is retained before the function replacement migration.
u=urllib.parse.urlsplit(c['DATABASE_URL'])
pg=os.environ.copy();pg.update(PGHOST=u.hostname,PGPORT=str(u.port or 5432),PGDATABASE=u.path[1:],PGUSER=urllib.parse.unquote(u.username),PGPASSWORD=urllib.parse.unquote(u.password))
subprocess.run(['pg_dump','--format=custom','--file='+str(backup/'database.dump')],env=pg,check=True)
assert (backup/'database.dump').stat().st_size>0
toc=subprocess.check_output(['pg_restore','--list',str(backup/'database.dump')]).decode()
assert 'TABLE DATA _timescaledb_internal' in toc, 'Timescale data missing from backup'
(backup/'baseline.json').write_text(json.dumps(baseline,indent=2));shutil.copy2(api,backup/'api.previous')
assert sha(backup/'api.previous')==baseline['api_sha256']
target=pathlib.Path('/home/mmm/releases')/m['release'];target.mkdir();dest=target/'web';dest.mkdir()
with tarfile.open(stage/'web.tar.gz') as t:
 for item in t.getmembers():assert (dest/item.name).resolve().is_relative_to(dest) and (item.isfile() or item.isdir())
 t.extractall(dest)
for name,h in m['web_files'].items():assert (dest/name).resolve().is_relative_to(dest) and sha(dest/name)==h
assert b'"/assets/' in (dest/'index.html').read_bytes()
for old in (web/'assets').iterdir():
 if old.is_file() and not (dest/'assets'/old.name).exists():shutil.copy2(old,dest/'assets'/old.name)
if (web/'uploads').is_symlink():(dest/'uploads').symlink_to((web/'uploads').resolve(),target_is_directory=True)
(dest/'version.json').write_text(json.dumps(dict(m,target='production'),indent=2))
for name in ('manifest.json','validation.json'):shutil.copy2(stage/name,target/name)
(target/'previous-web.txt').write_text(baseline['web'])
for root,dirs,files in os.walk(target):
 pathlib.Path(root).chmod(0o755)
 for name in files:
  p=pathlib.Path(root)/name
  if not p.is_symlink():p.chmod(0o644)
nextapi=api.with_name('gps-tracker-api.next-corporate');nextweb=web.with_name('dist-root.next-corporate')
assert not nextapi.exists() and not nextweb.exists() and not nextweb.is_symlink()
# Earlier binaries embedded Windows CRLF HTML. Git's canonical LF source is
# text-identical; ignore only CRLF differences, not any actual page content.
diagnostic_sha=lambda b:hashlib.sha256(b.replace(b'\r\n',b'\n')).hexdigest()
diagnostics={p:diagnostic_sha(get(p)) for p in ('/diagnostic','/diagnostic/device')}
disk_guard()
try:
 shutil.copy2(stage/'gps-tracker-api',nextapi);nextapi.chmod(0o755);os.replace(nextapi,api)
 run(['systemctl','restart','gps-tracker-api']);health(expected=m['api_release'])
 nextweb.symlink_to(dest,target_is_directory=True);os.replace(nextweb,web)
 assert json.loads(get('/version.json'))['git_commit']==m['git_commit']
 for name,h in m['web_files'].items():assert hashlib.sha256(get('/'+name)).hexdigest()==h
 for path in ('/','/corporate','/rentcar','/devices','/profile'):assert hashlib.sha256(get(path)).hexdigest()==sha(dest/'index.html')
 for path,h in diagnostics.items():assert diagnostic_sha(get(path))==h
 assert sha(env)==baseline['env_sha256'] and sha(nginx)==baseline['nginx_sha256']
 assert neighbors()==other
 with psycopg2.connect(c['DATABASE_URL']) as db:
  db.set_session(readonly=True,autocommit=True)
  with db.cursor() as cur:
   cur.execute("SELECT version,encode(checksum,'hex') FROM _sqlx_migrations WHERE success ORDER BY version");assert dict(cur.fetchall())==embedded
   cur.execute('SELECT count(*) FROM fleet_vehicles');assert cur.fetchone()[0]>=10
   cur.execute("SELECT count(*) FROM users u WHERE NOT EXISTS(SELECT 1 FROM fleet_expense_categories c WHERE c.owner_id=u.id)");assert cur.fetchone()[0]==0
 result={'release':m['release'],'web_commit':m['git_commit'],'api_release':m['api_release'],'schema':80,'neighbors_unchanged':True,'backup':str(backup),'api_sha256':sha(api)}
 (target/'deployment.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
except Exception:
 # Never reverse schema 80 or discard correction writes. If migration
 # committed, retain the new API for forward repair and revert only the UI.
 with psycopg2.connect(c['DATABASE_URL']) as db:
  db.set_session(readonly=True,autocommit=True)
  with db.cursor() as cur:
   cur.execute('SELECT max(version) FROM _sqlx_migrations WHERE success');version=cur.fetchone()[0]
 if version==79:
  shutil.copy2(backup/'api.previous',nextapi);nextapi.chmod(0o755);os.replace(nextapi,api)
 if nextweb.is_symlink():nextweb.unlink()
 nextweb.symlink_to(baseline['web'],target_is_directory=True);os.replace(nextweb,web)
 run(['systemctl','restart','gps-tracker-api'])
 raise RuntimeError('Release check failed. Prior web restored, data preserved. Schema '+str(version)+'; forward repair if migrated. Backup: '+str(backup))
