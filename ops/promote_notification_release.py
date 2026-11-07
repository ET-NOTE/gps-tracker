"""Reviewed notification release: no schema, firmware, nginx or environment change.
Requires clone/KC tests and an offsite backup; the user authorized prod/app work.
"""
import concurrent.futures
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import psycopg2

assert len(sys.argv)==3 and sys.argv[1]=='2026-09-28-user-approved'
os.umask(0o027)
release = sys.argv[2]
assert re.fullmatch(r'dev-20260928-[0-9]{6}-[a-f0-9]{7}',release)
stage = pathlib.Path('/home/mmm/gps-artifacts')/release
backup = pathlib.Path('/home/mmm/backups/gps-notifications-20260928')
target = pathlib.Path('/home/mmm/releases')/release.replace('dev-','prod-',1)
api = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
web = pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
env = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
nginx = pathlib.Path('/etc/nginx/sites-available/gps.serial.kr')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
def run(args): return subprocess.run(args,check=True)
def get(path,domain='gps.serial.kr'):
    with urllib.request.urlopen('https://'+domain+path,timeout=15) as r: return r.read()
m=json.loads((stage/'manifest.json').read_text())
assert m['release']==release and m['git_commit'].startswith(release.rsplit('-',1)[1])
assert sha(stage/'gps-tracker-api-dev')==m['api_sha256'] and sha(stage/'source.tar.gz')==m['source_sha256']
for name,digest in m['web_files'].items():
    p=(stage/'web'/name).resolve();assert p.is_relative_to(stage/'web') and sha(p)==digest
assert json.loads(get('/version.json','dev-gps.serial.kr'))['git_commit']==m['git_commit']
assert json.loads(get('/version.json'))['git_commit'].startswith('b340ba2')
assert (backup/'offsite-verified.json').exists() and (backup/'clone-check-passed.json').exists()
assert json.loads((backup/'clone-check-passed.json').read_text())['release']==release
assert sha(api)==sha(backup/'api.previous')
assert web.is_symlink() and not target.exists()
previous_web=web.resolve()
assert previous_web==pathlib.Path('/home/mmm/releases/prod-20260927-b340ba2/web')
v=dict(l.split('=',1) for l in env.read_text().splitlines() if '=' in l and not l.startswith('#'))
v={k:x.strip().strip('"').strip("'") for k,x in v.items()}
assert v['DATABASE_URL'].split('?',1)[0].endswith('/gps_tracker')
db=psycopg2.connect(v['DATABASE_URL']);db.set_session(readonly=True,autocommit=True);q=db.cursor()
def scalar(sql): q.execute(sql);return q.fetchone()[0]
assert scalar('SELECT max(version) FROM _sqlx_migrations')==65
controls="SELECT md5(string_agg(row_to_json(d)::text,'' ORDER BY id)) FROM (SELECT id,device_uid,owner_id,iccid,beep_pending,reset_pending,post_interval_pending FROM devices) d"
before={'api':sha(api),'env':sha(env),'nginx':sha(nginx),'controls':scalar(controls),
    'locations':scalar('SELECT count(*) FROM location_records'),
    'kc':{p:hashlib.sha256(get(p)).hexdigest() for p in ['/diagnostic','/diagnostic/device']}}
(backup/'baseline.json').write_text(json.dumps(before,indent=2))
target.mkdir(parents=True);target.parent.chmod(0o755)
shutil.copytree(stage/'web',target/'web')
for p in (previous_web/'assets').iterdir():
    if p.is_file() and not (target/'web/assets'/p.name).exists(): shutil.copy2(p,target/'web/assets'/p.name)
upload=pathlib.Path(v.get('UPLOAD_DIR','/home/mmm/uploads'))
assert upload.is_absolute() and upload.is_dir()
(target/'web/uploads').symlink_to(upload,target_is_directory=True)
shutil.copy2(stage/'manifest.json',target/'build-manifest.json')
shutil.copy2(stage/'source.tar.gz',target/'source.tar.gz')
(target/'web/version.json').write_text(json.dumps(dict(m,target='production',build_target='dev'),indent=2))
for root,dirs,files in os.walk(target):
    pathlib.Path(root).chmod(0o755)
    for name in files: (pathlib.Path(root)/name).chmod(0o644)
next_api=api.with_name(api.name+'.next-notifications')
next_web=web.with_name('dist-root.next-notifications')
assert not next_web.exists() and not next_web.is_symlink()
shutil.copy2(stage/'gps-tracker-api-dev',next_api);next_api.chmod(0o755)
# Verify embedded migration checksums without workers, listeners or FCM calls.
run(['systemd-run','--wait','--pipe','--collect','--unit=gps-notifications-migration-check',
    '-p','User=mmm','-p','WorkingDirectory=/home/mmm/projects/gps-tracker-api',
    '-p','EnvironmentFile='+str(env),'-p','MemoryMax=500M','--setenv=GPS_MIGRATE_ONLY=1',str(next_api)])
assert scalar(controls)==before['controls'] and sha(env)==before['env']
try:
    os.replace(next_api,api)
    run(['systemctl','restart','gps-tracker-api'])
    for attempt in range(15):
        try:
            h=json.loads(get('/health'))
            if h.get('release')==release and h.get('environment')=='production': break
        except Exception: pass
        time.sleep(1)
    else: raise RuntimeError('Production health failed')
    next_web.symlink_to(target/'web',target_is_directory=True);os.replace(next_web,web)
    for path in ['/','/devices','/profile?tab=chat']:
        assert hashlib.sha256(get(path)).hexdigest()==sha(target/'web/index.html')
    assert json.loads(get('/version.json'))['git_commit']==m['git_commit']
    def check_file(item):
        name,digest=item
        assert hashlib.sha256(get('/'+name)).hexdigest()==digest,name
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(check_file,m['web_files'].items()))
    for path,digest in before['kc'].items(): assert hashlib.sha256(get(path)).hexdigest()==digest
    for scheme in ['http','https']:
        req=urllib.request.Request(scheme+'://gps.serial.kr/ingest',data=b'{"device_uid":{}}',headers={'Content-Type':'application/json'})
        try: urllib.request.urlopen(req,timeout=15);raise AssertionError('Invalid payload accepted')
        except urllib.error.HTTPError as e: assert e.code==400 and json.loads(e.read())['error'].startswith('invalid payload:')
    assert 'error' not in json.loads(get('/diagnostic/device/data?uid=esp-release-readonly-check'))
    assert sha(env)==before['env'] and sha(nginx)==before['nginx'] and scalar(controls)==before['controls']
    assert scalar('SELECT count(*) FROM location_records')>=before['locations']
    result=dict(release=release,commit=m['git_commit'],schema=65,environment='production',
        env_nginx_and_device_controls_unchanged=True,kc_pages_unchanged=True,
        static_files_verified=len(m['web_files']),previous_web=str(previous_web),backup=str(backup))
    (target/'deployment.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result),flush=True)
except Exception:
    rollback=api.with_name(api.name+'.rollback-notifications')
    shutil.copy2(backup/'api.previous',rollback);rollback.chmod(0o755);os.replace(rollback,api)
    if next_web.is_symlink(): next_web.unlink()
    next_web.symlink_to(previous_web,target_is_directory=True);os.replace(next_web,web)
    run(['systemctl','restart','gps-tracker-api'])
    print('Restored previous API/web; no database rollback required.',flush=True)
    raise
finally: db.close()
