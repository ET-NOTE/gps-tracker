#!/usr/bin/env python3
"""Schema-99 API-only hotfix. Check every migration checksum; never deploy the unfinished ledger.
Stage the reviewed source archive, exact validated binary and validation/manifest JSON together.
No web, settings, environment, PDF processor or DB migration is changed.
"""
import fcntl, hashlib, json, os, pathlib, shutil, subprocess, sys, tarfile, time, urllib.request
import psycopg2

RELEASE='privacy-log-20261107-r1'
OLD='privacy-facts-20261106-r1'
OLD_HASH='1fc16f783259d18898456318ff2ad14eb7caa9278e3739609f077e967f115a4d'
SOURCE_COMMIT='ee295ece717eef7140171b289514bf1c62c007b5'
STAGE=pathlib.Path(__file__).resolve().parent
API=pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
ENV=pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
BACKUP=pathlib.Path('/home/mmm/backups')/RELEASE

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def health():
    with urllib.request.urlopen('http://127.0.0.1:3040/gps-tracker/health',timeout=3) as r:return json.load(r)
def cmd(*args):return subprocess.check_output(args,text=True,stderr=subprocess.DEVNULL).strip()
def migrations():
    cfg={k.strip():v.strip().strip('"').strip("'") for k,v in (l.split('=',1) for l in ENV.read_text().splitlines() if '=' in l and not l.lstrip().startswith('#'))}
    with psycopg2.connect(cfg['DATABASE_URL']) as db:
        db.set_session(readonly=True)
        with db.cursor() as q:
            q.execute("SELECT version,encode(checksum,'hex'),success FROM _sqlx_migrations ORDER BY version")
            rows=q.fetchall()
    assert all(r[2] for r in rows)
    return {str(r[0]):r[1] for r in rows}
def baseline():
    return {'env_sha256':sha(ENV),'web':str(pathlib.Path('/home/mmm/gps-tracker-web/dist-root').resolve()),
        'pdf_sha256':sha(API.with_name('gps-pdf-render')),
        'pdf_socket':cmd('systemctl','is-active','gps-pdf-render.socket'),
        'api_user':cmd('systemctl','show','gps-tracker-api','-p','User','--value')}
def preflight():
    m=json.loads((STAGE/'manifest.json').read_text());v=json.loads((STAGE/'validation.json').read_text())
    assert m['release']==RELEASE and m['schema']==99
    assert m['source_commit']==SOURCE_COMMIT
    assert m['source_sha256']==sha(STAGE/'source.tar.gz')
    assert m['api_sha256']==v['api_sha256']==sha(STAGE/'gps-tracker-api')
    assert m['release_script_sha256']==sha(pathlib.Path(__file__))
    assert v['fmt_clippy_passed'] and v['rust_passed']==65 and v['facts_groups']==6 and v['schema']==99
    assert m['validation_sha256']==sha(STAGE/'validation.json')
    built={}
    with tarfile.open(STAGE/'source.tar.gz') as archive:
        for member in archive.getmembers():
            if member.name.startswith('gps-tracker-api/migrations/') and member.name.endswith('.sql'):
                built[str(int(pathlib.PurePosixPath(member.name).name.split('_')[0]))]=hashlib.sha384(archive.extractfile(member).read()).hexdigest()
    assert set(built)=={str(n) for n in range(1,100)} and built==migrations(), 'migration checksum mismatch'
    assert sha(API)==OLD_HASH and health()=={'db':True,'environment':'production','ok':True,'release':OLD,'service':'gps-tracker-api'}
    assert shutil.disk_usage(API.parent).free>1024**3
    assert not BACKUP.exists(), 'previous attempt exists; review it first'
    return m,baseline(),built
def install(source):
    next=API.with_name('gps-tracker-api.log-next')
    assert not next.exists()
    with source.open('rb') as src,next.open('xb') as dst:
        shutil.copyfileobj(src,dst);dst.flush();os.fsync(dst.fileno())
    os.chmod(next,0o755);os.replace(next,API)
def restart_and_wait(release):
    subprocess.run(['systemctl','restart','gps-tracker-api'],check=True,timeout=90)
    for _ in range(30):
        try:
            h=health()
            if h.get('ok') and h.get('db') and h.get('release')==release:return
        except Exception:pass
        time.sleep(1)
    raise RuntimeError('health did not reach expected release')
def main():
    assert os.geteuid()==0
    lock=open('/run/lock/gps-api-log-hotfix.lock','w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    action=sys.argv[1];assert action in ('check','apply','rollback')
    if action=='rollback':
        m=json.loads((STAGE/'manifest.json').read_text())
        assert sha(API)==m['api_sha256'] and sha(BACKUP/'api.previous')==OLD_HASH
        assert health().get('release')==RELEASE and baseline()==json.loads((BACKUP/'baseline.json').read_text())
        assert migrations()==json.loads((BACKUP/'migrations.json').read_text())
        install(BACKUP/'api.previous');restart_and_wait(OLD)
        print(json.dumps({'rollback':'passed','schema':99,'health':health()}));return
    m,before,built=preflight()
    if action=='check':print(json.dumps({'preflight':'passed','schema':99,'api_sha256':m['api_sha256'],'changes':'API binary only'}));return
    BACKUP.mkdir(mode=0o700);shutil.copyfile(API,BACKUP/'api.previous');os.chmod(BACKUP/'api.previous',0o600)
    (BACKUP/'baseline.json').write_text(json.dumps(before))
    (BACKUP/'migrations.json').write_text(json.dumps(built))
    try:
        install(STAGE/'gps-tracker-api');restart_and_wait(RELEASE)
        assert baseline()==before and migrations()==built
        assert sha(API)==m['api_sha256']
    except Exception:
        install(BACKUP/'api.previous');restart_and_wait(OLD)
        raise
    print(json.dumps({'release':RELEASE,'schema':99,'health':health(),'unchanged_settings_web_pdf':True,
        'api_sha256':sha(API),'rollback_binary':str(BACKUP/'api.previous')}))

if __name__=='__main__':main()
