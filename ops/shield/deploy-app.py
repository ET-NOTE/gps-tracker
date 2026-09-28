#!/usr/bin/env python3
"""Apply a reviewed Shield release, optionally the specific post-images migration.

Default mode requires unchanged schema/configuration. --post-images-upgrade only
permits schema 6 -> 7 and the exact Shield upload nginx location/rate zone.
Never changes credentials, database settings or GPS code. Requires a fresh backup.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time
import urllib.request

def run(*args):return subprocess.check_output(args,text=True).strip()
def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def health():
    return json.load(urllib.request.urlopen('http://127.0.0.1:3043/health',timeout=5))
def schema():
    return json.loads(run('sudo','-u','postgres','psql','-XAt','-d','shield_prod','-c','SELECT json_agg(version ORDER BY version) FROM _sqlx_migrations'))
def baseline():
    nginx=Path('/etc/nginx/sites-enabled')
    return {'gps_binary':digest('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api'),
            'gps_process':run('systemctl','show','gps-tracker-api','-p','MainPID','-p','ActiveEnterTimestamp'),
            'nginx':{p.name:digest(p) for p in nginx.iterdir() if p.is_file()},
            'shield_env':digest('/etc/shield-api/shield.env')}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--release',required=True);p.add_argument('--sha256',required=True)
    p.add_argument('--previous',required=True);p.add_argument('--backup-sha256',required=True)
    p.add_argument('--post-images-upgrade',action='store_true')
    args=p.parse_args();assert os.geteuid()==0;os.umask(0o077)
    for name in [args.release,args.previous]:assert re.fullmatch(r'shield-\d{8}-\d{6}-[a-f0-9]{7}',name)
    assert re.fullmatch(r'[a-f0-9]{64}',args.sha256)
    current=Path('/srv/shield/current');previous=current.resolve()
    assert previous.name==args.previous and health()['release']==args.previous
    backup=Path('/var/backups/shield/latest.tar.gz').resolve()
    assert digest(backup)==args.backup_sha256 and time.time()-backup.stat().st_mtime<3600
    old_schema=schema()
    if args.post_images_upgrade:assert old_schema==[1,2,3,4,5,6]
    else:assert old_schema in ([1,2,3,4,5,6],[1,2,3,4,5,6,7])
    archive=Path('/home/mmm/shield-deploy')/args.release/(args.release+'.tar.gz')
    assert digest(archive)==args.sha256
    target=previous.parent/args.release;assert not target.exists()
    state=baseline();state.update(previous=args.previous,release=args.release,backup=str(backup),schema=schema())
    record=Path('/var/backups/shield-rollout')/args.release
    record.mkdir(mode=0o700);(record/'app-upgrade.json').write_text(json.dumps(state,indent=2))
    with tarfile.open(archive,'r:gz') as tar:
        members=tar.getmembers()
        for m in members:
            path=Path(m.name)
            assert path.parts[0]==args.release and not path.is_absolute() and '..' not in path.parts
            assert m.isfile() or m.isdir()
            m.uid=m.gid=0;m.uname=m.gname='root'
            m.mode=0o755 if m.isdir() or path.name=='shield-api' else 0o644
        tar.extractall(target.parent,members=members)
    subprocess.run(['sha256sum','--check','--status','SHA256SUMS'],cwd=target,check=True)
    expected=baseline()
    if args.post_images_upgrade:
        config=Path('/etc/nginx/sites-enabled/shield.serial.kr.conf')
        # Same ACME webroot substitution as the original production installer.
        proposed=(target/'ops/shield.serial.kr.conf').read_text().replace('/var/lib/letsencrypt','/var/www/certbot')
        zone='limit_req_zone $binary_remote_addr zone=shield_images:1m rate=30r/m;\n'
        block='''    location = /api/admin/post-images {
        client_max_body_size 2m;
        limit_req zone=shield_images burst=20 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3043;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 25s;
    }
'''
        assert proposed.count(zone)==1 and proposed.count(block)==1
        assert proposed.replace(zone,'').replace(block,'')==config.read_text(), 'Unexpected nginx drift'
        shutil.copyfile(config,record/'nginx.before.conf')
        config.write_text(proposed)
        try:run('nginx','-t')
        except Exception:
            shutil.copyfile(record/'nginx.before.conf',config)
            raise
        expected['nginx'][config.name]=digest(config)
    new=Path('/srv/shield/current.app-upgrade');assert not new.exists()
    new.symlink_to(target);os.replace(new,current)
    run('systemctl','restart','shield-api')
    try:
        for _ in range(20):
            try:
                assert health()['release']==args.release;break
            except Exception:time.sleep(1)
        else:raise RuntimeError('Shield release did not become healthy')
        assert schema()==(old_schema+[7] if args.post_images_upgrade else old_schema), 'Unexpected schema change; do not roll back blindly'
        assert baseline()==expected, 'Unrelated runtime configuration changed'
        if args.post_images_upgrade:
            run('systemctl','reload','nginx')
            shutil.copyfile(target/'ops/backup.py','/usr/local/sbin/shield-backup')
            os.chmod('/usr/local/sbin/shield-backup',0o700)
    except Exception:
        # Only roll back an app release while the prior schema is still intact.
        if schema()==state['schema']:
            if args.post_images_upgrade:
                shutil.copyfile(record/'nginx.before.conf',config)
                run('nginx','-t');run('systemctl','reload','nginx')
            new.symlink_to(previous);os.replace(new,current);run('systemctl','restart','shield-api')
        raise
    print(json.dumps({'release':args.release,'GPS':'unchanged','nginx':'Shield image upload only' if args.post_images_upgrade else 'unchanged','schema':schema()}))

if __name__=='__main__':main()
