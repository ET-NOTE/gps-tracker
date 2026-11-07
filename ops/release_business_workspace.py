"""Deploy the business workspace without schema changes. Root on seriallog only.
Validates the release against an isolated clone before swapping API/web; rollback is automatic.
"""
import hashlib, json, os, pathlib, re, shutil, subprocess, sys, tarfile, time, urllib.parse, urllib.request
import psycopg2
mode, release, commit = sys.argv[1:4]
assert mode in ('validate','promote')
assert re.fullmatch(r'dev-\d{8}-\d{6}-[0-9a-f]{7}',release)
assert re.fullmatch(r'[0-9a-f]{40}',commit)
stage=pathlib.Path('/home/mmm/gps-artifacts')/release
manifest=json.loads((stage/'manifest.json').read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert manifest['release']==release and manifest['git_commit']==commit
assert sha(stage/'gps-tracker-api-dev')==manifest['api_sha256']
assert sha(stage/'source.tar.gz')==manifest['source_sha256']
for name,digest in manifest['web_files'].items():
    assert sha(stage/'web'/name)==digest
os.umask(0o077)
def envfile(path):
    return {k:v.strip().strip('"').strip("'") for k,v in (line.split('=',1) for line in path.read_text().splitlines() if '=' in line and not line.startswith('#'))}
def run(args): subprocess.run(args,check=True)
def get(path,local=False):
    with urllib.request.urlopen(('http://127.0.0.1:3042' if local else 'https://gps.serial.kr')+path,timeout=20) as r: return r.read()
def health(local=False,expected=None):
    for _ in range(25):
        try:
            value=json.loads(get('/health',local))
            if value.get('ok') and value.get('db') and (not expected or value.get('release')==expected): return value
        except Exception: pass
        time.sleep(1)
    raise RuntimeError('Health check failed')
validation_env=pathlib.Path('/home/mmm/backups/gps-connection-20261009/validation.env')
if mode=='validate':
    cfg=envfile(validation_env)
    assert urllib.parse.urlsplit(cfg['DATABASE_URL']).path=='/gps_tracker_dev_prodreview_20261009_connection'
    assert cfg['BIND_ADDR']=='127.0.0.1:3042' and cfg['APP_ENV']=='test'
    for key in ('OPENAI_API_KEY','KAKAO_REST_API_KEY','FCM_SERVICE_ACCOUNT_PATH','TOSS_SECRET_KEY','ONCE_API_TOKEN','ONCE_API_CLIENT_SECRET'):
        assert not cfg.get(key),'External credentials are not allowed in validation'
    assert not any((p/'.env').exists() for p in [stage,*stage.parents])
    import socket
    with socket.socket() as s: assert s.connect_ex(('127.0.0.1',3042))!=0,'Clone port occupied'
    unit='gps-business-clone-check'
    try:
        (stage/'gps-tracker-api-dev').chmod(0o755)
        run(['systemd-run','--collect','--unit='+unit,'-p','User=mmm','-p','Group=mmm','-p','EnvironmentFile='+str(validation_env),'-p','WorkingDirectory='+str(stage),'-p','MemoryMax=500M',str(stage/'gps-tracker-api-dev')])
        health(True,release)
        for script in ('test_business_api.py','test_dev_api.py','test_dev_resilience.py','test_dev_speed.py','test_app_fcm_kc.py'):
            run(['python3',str(stage/script),str(validation_env),'http://127.0.0.1:3042'])
        (stage/'business-validation.json').write_text(json.dumps({'api_sha256':manifest['api_sha256'],'commit':commit}))
        print('PASS isolated business/API integration',flush=True)
    finally:
        subprocess.run(['systemctl','stop',unit],check=False)
    sys.exit(0)
assert json.loads((stage/'business-validation.json').read_text())['api_sha256']==manifest['api_sha256']
api=pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
web=pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
envpath=pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
nginx=pathlib.Path('/etc/nginx/sites-available/gps.serial.kr')
assert sha(api)=='6cd615fe9b188aebdbf14af0979d0bd2a2834f698a16455d5e6c020ed1f340c9','API baseline changed'
assert json.loads((web/'version.json').read_text())['git_commit']=='50c11c54b0d37520e99f29dba714b63ae425e4a3','Web baseline changed'
cfg=envfile(envpath)
with psycopg2.connect(cfg['DATABASE_URL']) as db:
    db.set_session(readonly=True,autocommit=True)
    with db.cursor() as cur:
        cur.execute("SELECT version,encode(checksum,'hex') FROM _sqlx_migrations WHERE success ORDER BY version")
        applied=dict(cur.fetchall())
with tarfile.open(stage/'source.tar.gz') as archive:
    embedded={int(pathlib.PurePosixPath(m.name).name.split('_')[0]):hashlib.sha384(archive.extractfile(m).read()).hexdigest() for m in archive.getmembers() if m.isfile() and m.name.startswith('gps-tracker-api/migrations/') and m.name.endswith('.sql')}
assert applied==embedded,'Schema must remain identical for this deployment'
backup=pathlib.Path('/home/mmm/backups')/('business-'+release)
backup.mkdir()
baseline={'api_sha256':sha(api),'web':str(web.resolve()),'env_sha256':sha(envpath),'nginx_sha256':sha(nginx),'schema':max(applied),'health':health()}
(backup/'baseline.json').write_text(json.dumps(baseline,indent=2))
shutil.copy2(api,backup/'api.previous')
shutil.copy2(web/'version.json',backup/'web-version.previous.json')
assert sha(backup/'api.previous')==baseline['api_sha256']
diagnostics={p:hashlib.sha256(get(p)).hexdigest() for p in ('/diagnostic','/diagnostic/device')}
target=pathlib.Path('/home/mmm/releases')/release.replace('dev-','prod-',1)
target.mkdir()
shutil.copytree(stage/'web',target/'web')
for f in (web/'assets').iterdir():
    if f.is_file() and not (target/'web/assets'/f.name).exists(): shutil.copy2(f,target/'web/assets'/f.name)
uploads=pathlib.Path(cfg.get('UPLOAD_DIR','/home/mmm/uploads'))
assert uploads.is_absolute() and uploads.is_dir()
(target/'web/uploads').symlink_to(uploads,target_is_directory=True)
for name in ('manifest.json','source.tar.gz','business-validation.json'): shutil.copy2(stage/name,target/name)
(target/'web/version.json').write_text(json.dumps(dict(manifest,target='production'),indent=2))
for parent,dirs,files in os.walk(target):
    pathlib.Path(parent).chmod(0o755)
    for name in files: (pathlib.Path(parent)/name).chmod(0o644)
nextapi=api.with_name('gps-tracker-api.next-business'); nextweb=web.with_name('dist-root.next-business')
assert not nextapi.exists() and not nextweb.exists() and not nextweb.is_symlink()
try:
    shutil.copy2(stage/'gps-tracker-api-dev',nextapi); nextapi.chmod(0o755); os.replace(nextapi,api)
    run(['systemctl','restart','gps-tracker-api'])
    health(expected=release)
    nextweb.symlink_to(target/'web',target_is_directory=True); os.replace(nextweb,web)
    assert json.loads(get('/version.json'))['git_commit']==commit
    for name,digest in manifest['web_files'].items(): assert hashlib.sha256(get('/'+name)).hexdigest()==digest
    for path,digest in diagnostics.items(): assert hashlib.sha256(get(path)).hexdigest()==digest
    assert sha(envpath)==baseline['env_sha256'] and sha(nginx)==baseline['nginx_sha256']
    for path in ('/gps-tracker-1.0.4-10.zip','/gps-tracker-1.0.4-10.apk'):
        with urllib.request.urlopen(urllib.request.Request('https://gps.serial.kr'+path,method='HEAD'),timeout=20) as r: assert r.status==200
    result={'release':release,'commit':commit,'schema_unchanged':max(applied),'api_sha256':sha(api),'backup':str(backup),'diagnostics_unchanged':True,'android_downloads_ok':True}
    (target/'deployment.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
except Exception:
    shutil.copy2(backup/'api.previous',nextapi);nextapi.chmod(0o755);os.replace(nextapi,api)
    if nextweb.is_symlink(): nextweb.unlink()
    nextweb.symlink_to(baseline['web'],target_is_directory=True);os.replace(nextweb,web)
    run(['systemctl','restart','gps-tracker-api']); health(expected=baseline['health']['release'])
    print('Rolled back API/web; no schema changes.',flush=True)
    raise
