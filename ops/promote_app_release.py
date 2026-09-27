"""One reviewed production promotion, authorized by the user on 2026-09-27.
Requires successful clone/KC preflight and the offsite backup before invocation.
Does not send device commands or test pushes. Keeps an additive-schema rollback.
"""
import ctypes
import hashlib
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import psycopg2

assert sys.argv[1:] == ['2026-09-27-user-approved']
os.umask(0o027)
release = 'dev-20260927-150045-b340ba2'
stage = pathlib.Path('/home/mmm/gps-artifacts')/release
backup = pathlib.Path('/home/mmm/backups/gps-app-fcm-20260927')
target = pathlib.Path('/home/mmm/releases/prod-20260927-b340ba2')
api = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
web = pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
env_file = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
nginx = pathlib.Path('/etc/nginx/sites-available/gps.serial.kr')
manifest = json.loads((stage/'manifest.json').read_text())
assert manifest['release'] == release and manifest['git_commit'].startswith('b340ba2')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(stage/'gps-tracker-api-dev') == manifest['api_sha256']
assert sha(stage/'source.tar.gz') == manifest['source_sha256']
for name,digest in manifest['web_files'].items():
    path = (stage/'web'/name).resolve();assert path.is_relative_to(stage/'web') and sha(path) == digest
assert (backup/'api.rollback-compatible').exists() and (backup/'logical-manifest.json').exists()
assert not target.exists(), 'release directory already exists'

def run(args, **kwargs): return subprocess.run(args, check=True, **kwargs)
def get(path):
    with urllib.request.urlopen('https://gps.serial.kr'+path, timeout=20) as r: return r.read()
def exchange(a,b):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.renameat2(-100,os.fsencode(a),-100,os.fsencode(b),2) != 0:
        raise OSError(ctypes.get_errno(),'atomic directory exchange failed')

values = dict(l.split('=',1) for l in env_file.read_text().splitlines() if '=' in l and not l.startswith('#'))
values = {k:v.strip().strip('"').strip("'") for k,v in values.items()}
assert values['DATABASE_URL'].split('?',1)[0].endswith('/gps_tracker')
db = psycopg2.connect(values['DATABASE_URL']);db.set_session(readonly=True,autocommit=True);cur=db.cursor()
def scalar(q): cur.execute(q);return cur.fetchone()[0]
device_sql = "SELECT md5(string_agg(row_to_json(d)::text,'' ORDER BY d.id)) FROM (SELECT id,device_uid,owner_id,iccid,beep_pending,reset_pending,post_interval_pending FROM devices) d"
baseline = {'env_sha256':sha(env_file),'nginx_sha256':sha(nginx),'api_sha256':sha(api),
    'location_rows':scalar('SELECT count(*) FROM location_records'), 'device_settings_hash':scalar(device_sql),
    'kc_html':{p:hashlib.sha256(get(p)).hexdigest() for p in ['/diagnostic','/diagnostic/device']}}
(backup/'promotion-baseline.json').write_text(json.dumps(baseline,indent=2))
target.mkdir(parents=True)
# nginx must traverse the release parent even when created under umask 0027.
target.parent.chmod(0o755)
shutil.copytree(stage/'web',target/'web')
# Keep the previous hashed chunks for already-open browsers' lazy imports.
for old in (web/'assets').iterdir():
    if old.is_file() and not (target/'web/assets'/old.name).exists(): shutil.copy2(old,target/'web/assets'/old.name)
upload = pathlib.Path(values.get('UPLOAD_DIR','/home/mmm/uploads'))
assert upload.is_absolute()
# Older production has no uploads until the first attachment. Prepare the
# configured storage with the API service owner's permissions before cutover.
if not upload.exists():
    assert upload == pathlib.Path('/home/mmm/uploads'), 'review a non-default missing upload directory'
    upload.mkdir(mode=0o755)
    owner = pwd.getpwnam('mmm')
    os.chown(upload,owner.pw_uid,owner.pw_gid)
assert upload.is_dir() and not upload.is_symlink()
(target/'web/uploads').symlink_to(upload, target_is_directory=True)
shutil.copy2(stage/'source.tar.gz',target/'source.tar.gz')
shutil.copy2(stage/'manifest.json',target/'build-manifest.json')
deployed = dict(manifest,build_target=manifest['target'],target='production')
(target/'web/version.json').write_text(json.dumps(deployed,indent=2))
for root,dirs,files in os.walk(target):
    pathlib.Path(root).chmod(0o755)
    for name in files: (pathlib.Path(root)/name).chmod(0o644)
next_api = api.with_name(api.name+'.next')
shutil.copy2(stage/'gps-tracker-api-dev',next_api);next_api.chmod(0o755)
# Old API continues handling KC traffic while schema is added. This process exits
# before starting any worker or listener, including the FCM dry-run worker.
started = time.monotonic()
run(['systemd-run','--wait','--pipe','--collect','--unit=gps-prod-migrate-b340ba2',
    '-p','User=mmm','-p','WorkingDirectory=/home/mmm/projects/gps-tracker-api',
    '-p','EnvironmentFile='+str(env_file),'-p','MemoryMax=500M','-p','NoNewPrivileges=true',
    '--setenv=GPS_MIGRATE_ONLY=1',str(next_api)])
assert scalar('SELECT max(version) FROM _sqlx_migrations') == 65
assert scalar('SELECT count(*) FROM location_records') >= baseline['location_rows']
assert scalar(device_sql) == baseline['device_settings_hash'], 'device command/ownership state changed during preflight'
assert sha(env_file) == baseline['env_sha256']
print('PASS additive migrations while current production API remained running; seconds=%.2f' % (time.monotonic()-started),flush=True)
next_web = web.with_name('dist-root.next-app-release')
assert not next_web.exists() and not next_web.is_symlink()
next_web.symlink_to(target/'web',target_is_directory=True)
swapped = False
nginx_changed = False
try:
    config = nginx.read_text()
    needle = 'location /api/v1/ {'
    assert config.count(needle) == 1
    updated = config.replace(needle,needle+'\n        client_max_body_size 40m;',1)
    nginx.write_text(updated);nginx_changed=True
    run(['nginx','-t'])
    os.replace(next_api,api)
    exchange(web,next_web);swapped=True
    run(['systemctl','restart','gps-tracker-api'])
    run(['systemctl','reload','nginx'])
    health = None
    for _ in range(15):
        try:
            health = json.loads(get('/health'))
            if health.get('release') == release and health.get('environment') == 'production': break
        except Exception: pass
        time.sleep(1)
    assert health and health.get('release') == release and health.get('environment') == 'production'
    assert hashlib.sha256(get('/')).hexdigest() == sha(target/'web/index.html')
    public_manifest = json.loads(get('/version.json'))
    assert public_manifest['target'] == 'production' and public_manifest['git_commit'] == manifest['git_commit']
    assert hashlib.sha256(get('/devices')).hexdigest() == sha(target/'web/index.html')
    for path,digest in baseline['kc_html'].items(): assert hashlib.sha256(get(path)).hexdigest() == digest
    assert sha(env_file) == baseline['env_sha256']
    # Semantic payload deserialization returns our JSON 400 before device lookup
    # or writes (the route first extracts Json<Value>, so this is not Axum 422).
    for scheme in ('http','https'):
        req=urllib.request.Request(scheme+'://gps.serial.kr/ingest',data=b'{"device_uid":{}}',headers={'Content-Type':'application/json'})
        try: urllib.request.urlopen(req,timeout=15);raise AssertionError('malformed ingest accepted')
        except urllib.error.HTTPError as e:
            assert e.code == 400
            assert json.loads(e.read()).get('error','').startswith('invalid payload:')
    log = json.loads(get('/diagnostic/device/data?uid=esp-release-readonly-check'))
    assert log.get('uid') == 'esp-release-readonly-check' and 'error' not in log
    previous_web = backup/'web.previous-dir'
    os.rename(next_web,previous_web)
    result = dict(release=release,commit=manifest['git_commit'],environment='production',
        kc_pages_unchanged=True,env_unchanged=True,firmware_unchanged=True,
        api_sha256=sha(api),web_index_sha256=sha(web/'index.html'),nginx_sha256=sha(nginx),
        migrations=65,rollback_api=str(backup/'api.rollback-compatible'),previous_web=str(previous_web))
    (target/'deployment.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result),flush=True)
except Exception:
    if nginx_changed: shutil.copy2(backup/'nginx.previous',nginx)
    if swapped: exchange(web,next_web)
    rollback=api.with_name(api.name+'.rollback')
    shutil.copy2(backup/'api.rollback-compatible',rollback);rollback.chmod(0o755);os.replace(rollback,api)
    run(['systemctl','restart','gps-tracker-api']);run(['systemctl','reload','nginx'])
    print('Restored compatible pre-release API and previous web/nginx; database preserved.',flush=True)
    raise
finally: db.close()
