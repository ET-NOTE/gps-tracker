"""SIM identity correction: additive schema 71, private clone validation, atomic runtime rollback."""
import hashlib,json,os,pathlib,re,shutil,subprocess,sys,tarfile,time,urllib.request
import psycopg2
release,commit=sys.argv[1:3]
schema=int(sys.argv[3]) if len(sys.argv)>3 else 71
assert schema in (71,72)
assert re.fullmatch(r'dev-20261020-\d{6}-[0-9a-f]{7}',release) and re.fullmatch('[0-9a-f]{40}',commit)
stage=pathlib.Path('/home/mmm/gps-artifacts')/release
backup=pathlib.Path('/home/mmm/backups')/('gps-sim-20261020' if schema==71 else 'gps-sim-first-20261020')
api=pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api');web=pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
env=pathlib.Path('/home/mmm/projects/gps-tracker-api/.env');nginx=pathlib.Path('/etc/nginx/sites-available/gps.serial.kr')
target=pathlib.Path('/home/mmm/releases')/release.replace('dev-','prod-',1)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
run=lambda args:subprocess.run(args,check=True)
os.umask(0o077)
def get(path):
 with urllib.request.urlopen('https://gps.serial.kr'+path,timeout=20) as r:return r.read()
def health(expected=None):
 for _ in range(25):
  try:
   r=json.loads(get('/health'))
   if r['ok'] and r['db'] and (not expected or r['release']==expected):return r
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('health failed')
m=json.loads((stage/'manifest.json').read_text());saved=json.loads((backup/'baseline.json').read_text())
assert m['release']==release and m['git_commit']==commit
assert sha(stage/'gps-tracker-api-dev')==m['api_sha256'] and sha(stage/'source.tar.gz')==m['source_sha256']
for name,h in m['web_files'].items():assert sha(stage/'web'/name)==h
assert json.loads((backup/'validation-passed.json').read_text())['api_sha256']==m['api_sha256']
assert json.loads((backup/'rollback-check.json').read_text())['api_sha256']==sha(backup/f'api.rollback-schema{schema}')
for name,h in json.loads((backup/'offsite-verified.json').read_text())['files'].items():assert sha(backup/name)==h
assert sha(api)==saved['api_sha256'] and str(web.resolve())==saved['web']
assert sha(env)==saved['env_sha256'] and sha(nginx)==saved['nginx_sha256']
cfg=dict((k,v.strip().strip('"').strip("'")) for k,v in (line.split('=',1) for line in env.read_text().splitlines() if '=' in line and not line.startswith('#')))
with psycopg2.connect(cfg['DATABASE_URL']) as db:
 db.set_session(readonly=True,autocommit=True)
 with db.cursor() as c:
  c.execute("SELECT version,encode(checksum,'hex') FROM _sqlx_migrations WHERE success ORDER BY version");applied=dict(c.fetchall())
  c.execute('SELECT count(*) FROM location_records WHERE device_id=3163 AND user_id=28');previous_records=c.fetchone()[0]
with tarfile.open(stage/'source.tar.gz') as t:
 embedded={int(pathlib.PurePosixPath(f.name).name.split('_')[0]):hashlib.sha384(t.extractfile(f).read()).hexdigest() for f in t.getmembers() if f.isfile() and f.name.startswith('gps-tracker-api/migrations/') and f.name.endswith('.sql')}
assert set(embedded)-set(applied)=={schema} and all(embedded[v]==h for v,h in applied.items())
target.mkdir();shutil.copytree(stage/'web',target/'web')
for f in (web/'assets').iterdir():
 if f.is_file() and not (target/'web/assets'/f.name).exists():shutil.copy2(f,target/'web/assets'/f.name)
(target/'web/uploads').symlink_to(pathlib.Path(cfg.get('UPLOAD_DIR','/home/mmm/uploads')),target_is_directory=True)
(target/'web/version.json').write_text(json.dumps(dict(m,target='production'),indent=2))
for name in ('manifest.json','source.tar.gz'):shutil.copy2(stage/name,target/name)
target.chmod(0o755)
for p in target.rglob('*'):
 if not p.is_symlink():p.chmod(0o755 if p.is_dir() else 0o644)
nextapi=api.with_name(api.name+'.next-sim');nextweb=web.with_name('dist-root.next-sim')
assert not nextweb.exists() and not nextweb.is_symlink()
try:
 run(['systemd-run','--wait','--pipe','--collect',f'--unit=gps-sim-migrate-{schema}','-p','User=mmm','-p','Group=mmm','-p','EnvironmentFile='+str(env),'-p','WorkingDirectory='+str(stage),'-E','GPS_MIGRATE_ONLY=1',str(stage/'gps-tracker-api-dev')])
 shutil.copy2(stage/'gps-tracker-api-dev',nextapi);nextapi.chmod(0o755);os.replace(nextapi,api)
 run(['systemctl','restart','gps-tracker-api']);health(release)
 nextweb.symlink_to(target/'web',target_is_directory=True);os.replace(nextweb,web)
 assert json.loads(get('/version.json'))['git_commit']==commit
 for name,h in m['web_files'].items():assert hashlib.sha256(get('/'+name)).hexdigest()==h
 assert sha(env)==saved['env_sha256'] and sha(nginx)==saved['nginx_sha256']
 with psycopg2.connect(cfg['DATABASE_URL']) as db:
  with db.cursor() as c:
   c.execute('SELECT count(*) FROM location_records WHERE device_id=3163 AND user_id=28');assert c.fetchone()[0]>=previous_records
 result={'release':release,'commit':commit,'schema':schema,'api_sha256':sha(api),'backup':str(backup),'previous_device_3163_records':previous_records,'configuration_unchanged':True}
 (target/'deployment.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
except Exception:
 shutil.copy2(backup/f'api.rollback-schema{schema}',nextapi);nextapi.chmod(0o755);os.replace(nextapi,api)
 if nextweb.is_symlink():nextweb.unlink()
 nextweb.symlink_to(saved['web'],target_is_directory=True);os.replace(nextweb,web)
 run(['systemctl','restart','gps-tracker-api']);health()
 print('Runtime restored; additive schema and SIM records retained.',flush=True)
 raise
