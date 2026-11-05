"""Pinned GPS-only privacy delivery release. No user policy is changed here."""
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tarfile
import time
import urllib.request

import psycopg2
from privacy_file_cleanup import config

STAGE = pathlib.Path('/home/mmm/gps-artifacts/privacy-delivery-20261105-r2')
API = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
ENV = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
WEB = pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
RELEASE = pathlib.Path('/home/mmm/releases/privacy-delivery-20261105-r2/web')
BACKUP = pathlib.Path('/home/mmm/backups/privacy-delivery-20261105-r2')
OPS = pathlib.Path('/home/mmm/gps-ops')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
run = lambda a: subprocess.run(a, check=True, capture_output=True)


def neighbors():
    return {'dev_api': sha(pathlib.Path('/home/gps-dev/projects/gps-tracker-api/bin/gps-tracker-api-dev')),
        'dev_web': str(pathlib.Path('/home/gps-dev/gps-tracker-web-dev/dist').resolve()),
        'shield': str(pathlib.Path('/srv/shield/current').resolve()),
        'processes': run(['systemctl','show','gps-tracker-api-dev','shield-api','-p','MainPID','-p','ActiveEnterTimestamp']).stdout.decode()}


def main():
    os.umask(0o077)
    assert os.geteuid()==0
    manifest=json.loads((STAGE/'manifest.json').read_text())
    validation=json.loads((STAGE/'validation.json').read_text())
    assert validation['schema']==89 and validation['delivery_groups']==11 and validation['closure_groups']==12
    assert validation['api_sha256']==manifest['api_sha256']==sha(STAGE/'gps-tracker-api')
    assert manifest['web_sha256']==sha(STAGE/'web.tar.gz')
    with tarfile.open(STAGE/'web.tar.gz') as archive:
        index = archive.extractfile('./index.html').read().decode()
        entries = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', index)
        assert entries and '/gps-tracker/app/assets/' not in index
        for entry in entries:
            assert archive.getmember('.'+entry).isfile()
    assert manifest['source_sha256']==sha(STAGE/'focused-source.tar.gz')
    assert sha(API)=='720c1d742016bddced9882e428aeff37e735c853a93c55d9401a664146cac4d9'
    assert str(WEB.resolve())=='/home/mmm/releases/privacy-delivery-20261105-r1/web'
    assert shutil.disk_usage(STAGE).free>1024**3
    for name,digest in manifest['ops_files'].items():assert sha(STAGE/name)==digest
    migrations={}
    with tarfile.open(STAGE/'focused-source.tar.gz') as archive:
        for member in archive.getmembers():
            if member.isfile():
                data=archive.extractfile(member).read()
                assert hashlib.sha256(data).hexdigest()==manifest['source_files'][member.name]
                if member.name.startswith('gps-tracker-api/migrations/'):
                    migrations[int(pathlib.PurePosixPath(member.name).name.split('_')[0])]=data
    assert set(migrations)==set(range(1,90))
    with psycopg2.connect(config(ENV)['DATABASE_URL']) as check_db:
        with check_db.cursor() as q:
            q.execute("SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(device_id,blocked,collection_paused,collection_enforced,collection_epoch,collection_changed_at) ORDER BY device_id)::text,'')) FROM device_data_controls c")
            policy_before=q.fetchone()[0]
    baseline={'api':sha(API),'env':sha(ENV),'web':str(WEB.resolve()),'neighbors':neighbors()}
    BACKUP.mkdir();shutil.copy2(API,BACKUP/'api.previous')
    (BACKUP/'baseline.json').write_text(json.dumps(baseline,indent=2))
    RELEASE.mkdir(parents=True)
    with tarfile.open(STAGE/'web.tar.gz') as archive:
        for member in archive.getmembers():
            target=(RELEASE/member.name).resolve()
            assert target==RELEASE or RELEASE in target.parents
            assert member.isfile() or member.isdir()
        for member in archive.getmembers():
            target=(RELEASE/member.name).resolve()
            if member.isdir():target.mkdir(parents=True,exist_ok=True)
            else:
                target.parent.mkdir(parents=True,exist_ok=True)
                with archive.extractfile(member) as source, target.open('wb') as dest:shutil.copyfileobj(source,dest)
    for p in [RELEASE.parent,RELEASE,*RELEASE.rglob('*')]:p.chmod(0o755 if p.is_dir() else 0o644)
    staged=API.with_name('gps-tracker-api.next-delivery')
    assert not staged.exists();shutil.copy2(STAGE/'gps-tracker-api',staged);staged.chmod(0o755)
    cfg=config(ENV)
    with psycopg2.connect(cfg['DATABASE_URL']) as db:
        with db.cursor() as q:
            q.execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'")
            q.execute("SELECT version,encode(checksum,'hex') FROM _sqlx_migrations WHERE success ORDER BY version")
            assert dict(q.fetchall())=={v:hashlib.sha384(b).hexdigest() for v,b in migrations.items()}
        db.commit()
    # SQLx migration is retained on failure. Repair forward, not an old binary.
    os.replace(staged,API);run(['systemctl','restart','gps-tracker-api'])
    for _ in range(30):
        try:
            with urllib.request.urlopen('https://gps.serial.kr/health',timeout=5) as r:health=json.load(r)
            if health['ok'] and health['db'] and health['release']==manifest['release']:break
        except Exception:pass
        time.sleep(1)
    else:raise RuntimeError('API health failed; keep schema and repair forward')
    link=WEB.with_name('dist-root.next-delivery');assert not link.exists()
    link.symlink_to(RELEASE);os.replace(link,WEB)
    assert neighbors()==baseline['neighbors'] and sha(ENV)==baseline['env']
    assert run(['systemctl','is-active','gps-privacy-accounts.timer']).stdout.strip()==b'active'
    with urllib.request.urlopen('https://gps.serial.kr/profile',timeout=10) as r:html=r.read()
    assert (RELEASE/'index.html').read_bytes()==html
    for entry in entries:
        with urllib.request.urlopen('https://gps.serial.kr'+entry,timeout=10) as r:
            assert r.read()==(RELEASE/entry.lstrip('/')).read_bytes()
    with psycopg2.connect(config(ENV)['DATABASE_URL']) as check_db:
        with check_db.cursor() as q:
            q.execute("SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(device_id,blocked,collection_paused,collection_enforced,collection_epoch,collection_changed_at) ORDER BY device_id)::text,'')) FROM device_data_controls c")
            assert q.fetchone()[0]==policy_before
    report={'release':manifest['release'],'schema':89,'api_sha256':sha(API),'web':str(WEB.resolve()),
        'health':health,'neighbor_releases_unchanged':True,'existing_collection_policies_unchanged':True,
        'timer_active':True}
    (STAGE/'deployment.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))


if __name__=='__main__':main()
