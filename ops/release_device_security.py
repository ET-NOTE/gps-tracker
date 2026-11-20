"""Pinned production promotion after clone tests; additive schema 69/70 retained on rollback."""
import hashlib,json,os,pathlib,shutil,subprocess,tarfile,time,urllib.request
import psycopg2

os.umask(0o077)
release='dev-20261020-131847-7bcbff3'
commit='7bcbff3346fe8bf51d59a61c1085a631ba49bfdb'
stage=pathlib.Path('/home/mmm/gps-artifacts')/release
backup=pathlib.Path('/home/mmm/backups/gps-security-20261020')
api=pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
envpath=pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
web=pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
nginx=pathlib.Path('/etc/nginx/sites-available/gps.serial.kr')
target=pathlib.Path('/home/mmm/releases')/release.replace('dev-','prod-',1)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
run=lambda args:subprocess.run(args,check=True)
def config(p):
 return dict((k,v.strip().strip('"').strip("'")) for k,v in (l.split('=',1) for l in p.read_text().splitlines() if '=' in l and not l.startswith('#')))
def get(path):
 with urllib.request.urlopen('https://gps.serial.kr'+path,timeout=20) as r:return r.read()
def health(expected=None):
 for _ in range(25):
  try:
   h=json.loads(get('/health'))
   if h['ok'] and h['db'] and (not expected or h['release']==expected):return h
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('Production health check failed')

manifest=json.loads((stage/'manifest.json').read_text());saved=json.loads((backup/'baseline.json').read_text())
assert manifest['git_commit']==commit and manifest['release']==release
assert sha(stage/'gps-tracker-api-dev')==manifest['api_sha256'] and sha(stage/'source.tar.gz')==manifest['source_sha256']
for name,h in manifest['web_files'].items():assert sha(stage/'web'/name)==h
assert json.loads((backup/'rollback-check.json').read_text())['api_sha256']==sha(backup/'api.rollback-schema70')
assert json.loads((backup/'validation-passed.json').read_text())['api_sha256']==manifest['api_sha256']
for name,h in json.loads((backup/'offsite-verified.json').read_text())['files'].items():assert sha(backup/name)==h
assert sha(api)==saved['api_sha256'] and str(web.resolve())==saved['web']
assert sha(envpath)==saved['env_sha256'] and sha(nginx)==saved['nginx_sha256']
cfg=config(envpath)
assert cfg.get('APP_ENV','production')=='production' and health()['environment']=='production'
with psycopg2.connect(cfg['DATABASE_URL']) as db:
 db.set_session(readonly=True,autocommit=True)
 with db.cursor() as c:
  c.execute("SELECT version,encode(checksum,'hex') FROM _sqlx_migrations WHERE success ORDER BY version");applied=dict(c.fetchall())
with tarfile.open(stage/'source.tar.gz') as t:
 embedded={int(pathlib.PurePosixPath(m.name).name.split('_')[0]):hashlib.sha384(t.extractfile(m).read()).hexdigest() for m in t.getmembers() if m.isfile() and m.name.startswith('gps-tracker-api/migrations/') and m.name.endswith('.sql')}
assert set(embedded)-set(applied)=={69,70} and all(embedded[v]==h for v,h in applied.items())
diagnostics={p:hashlib.sha256(get(p)).hexdigest() for p in ('/diagnostic','/diagnostic/device')}
target.mkdir();shutil.copytree(stage/'web',target/'web')
for f in (web/'assets').iterdir():
 if f.is_file() and not (target/'web/assets'/f.name).exists():shutil.copy2(f,target/'web/assets'/f.name)
uploads=pathlib.Path(cfg.get('UPLOAD_DIR','/home/mmm/uploads'));assert uploads.is_absolute() and uploads.is_dir()
(target/'web/uploads').symlink_to(uploads,target_is_directory=True)
(target/'web/version.json').write_text(json.dumps(dict(manifest,target='production'),indent=2))
for name in ('manifest.json','source.tar.gz'):shutil.copy2(stage/name,target/name)
for p in target.rglob('*'):
 if not p.is_symlink():p.chmod(0o755 if p.is_dir() else 0o644)
target.chmod(0o755)
private=pathlib.Path('/home/mmm/gps-private-uploads');private.mkdir(exist_ok=True)
run(['chown','mmm:mmm',str(private)]);private.chmod(0o700)
private_images=private/'car-images';private_images.mkdir(exist_ok=True);run(['chown','mmm:mmm',str(private_images)]);private_images.chmod(0o700)
oldimages=uploads/'car-images'
if oldimages.exists():
 for f in oldimages.iterdir():
  assert f.is_file() and not f.is_symlink()
  dest=private_images/f.name
  if dest.exists():assert sha(dest)==sha(f)
  else:shutil.copy2(f,dest)
  run(['chown','mmm:mmm',str(dest)]);dest.chmod(0o600)
newcfg=dict(cfg,GPS_LEGACY_INGEST_ENABLED='1',GPS_KC_INGEST_ENABLED='0',GPS_KC_PAIRING_ENABLED='0',PRIVATE_UPLOAD_DIR=str(private))
lines=envpath.read_text().splitlines()
updates={k:newcfg[k] for k in ('GPS_LEGACY_INGEST_ENABLED','GPS_KC_INGEST_ENABLED','GPS_KC_PAIRING_ENABLED','PRIVATE_UPLOAD_DIR')}
lines=[l for l in lines if l.split('=',1)[0] not in updates]
lines.extend(k+'='+v for k,v in updates.items())
nginxtext=nginx.read_text();needle='    # Versioned Android ZIP, independent of SPA releases.'
assert nginxtext.count(needle)==1
nginxtext=nginxtext.replace(needle,'    # Private vehicle photos are delivered only through the authenticated API.\n    location ^~ /uploads/car-images/ { return 404; }\n\n'+needle)
nextapi=api.with_name(api.name+'.next-security');nextweb=web.with_name('dist-root.next-security')
assert not nextweb.exists() and not nextweb.is_symlink()
try:
 envpath.write_text('\n'.join(lines)+'\n')
 nginx.write_text(nginxtext);run(['nginx','-t']);run(['systemctl','reload','nginx'])
 run(['systemd-run','--wait','--pipe','--collect','--unit=gps-security-migrate','-p','User=mmm','-p','Group=mmm','-p','EnvironmentFile='+str(envpath),'-p','WorkingDirectory='+str(stage),'-E','GPS_MIGRATE_ONLY=1',str(stage/'gps-tracker-api-dev')])
 shutil.copy2(stage/'gps-tracker-api-dev',nextapi);nextapi.chmod(0o755);os.replace(nextapi,api)
 run(['systemctl','restart','gps-tracker-api']);health(release)
 nextweb.symlink_to(target/'web',target_is_directory=True);os.replace(nextweb,web)
 assert json.loads(get('/version.json'))['git_commit']==commit
 for name,h in manifest['web_files'].items():assert hashlib.sha256(get('/'+name)).hexdigest()==h
 for path,h in diagnostics.items():assert hashlib.sha256(get(path)).hexdigest()==h
 with psycopg2.connect(cfg['DATABASE_URL']) as db:
  with db.cursor() as c:
   c.execute('SELECT max(version) FROM _sqlx_migrations WHERE success');assert c.fetchone()[0]==70
 result={'release':release,'commit':commit,'schema':70,'api_sha256':sha(api),'backup':str(backup),'legacy_existing_only':True,'kc_disabled':True,'private_images':True}
 (target/'deployment.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
except Exception:
 shutil.copy2(backup/'api.rollback-schema70',nextapi);nextapi.chmod(0o755);os.replace(nextapi,api)
 if nextweb.is_symlink():nextweb.unlink()
 nextweb.symlink_to(saved['web'],target_is_directory=True);os.replace(nextweb,web)
 shutil.copy2(backup/'prod.env',envpath);shutil.copy2(backup/'nginx.previous',nginx)
 run(['nginx','-t']);run(['systemctl','reload','nginx']);run(['systemctl','restart','gps-tracker-api']);health()
 print('Runtime rolled back; additive schemas and all records retained.',flush=True)
 raise
