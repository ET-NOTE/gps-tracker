#!/usr/bin/env python3
"""Apply a reviewed Shield app-only release with unchanged schema/configuration.

This is not the initial separation/migration operator. It never installs nginx,
credentials, database settings or GPS code. Requires a private pre-apply backup.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
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
    args=p.parse_args();assert os.geteuid()==0;os.umask(0o077)
    for name in [args.release,args.previous]:assert re.fullmatch(r'shield-\d{8}-\d{6}-[a-f0-9]{7}',name)
    assert re.fullmatch(r'[a-f0-9]{64}',args.sha256)
    current=Path('/srv/shield/current');previous=current.resolve()
    assert previous.name==args.previous and health()['release']==args.previous
    backup=Path('/var/backups/shield/latest.tar.gz').resolve()
    assert digest(backup)==args.backup_sha256 and time.time()-backup.stat().st_mtime<3600
    assert schema()==[1,2,3,4,5,6], 'Use migration procedure for other schema versions'
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
    new=Path('/srv/shield/current.app-upgrade');assert not new.exists()
    new.symlink_to(target);os.replace(new,current)
    run('systemctl','restart','shield-api')
    try:
        for _ in range(20):
            try:
                assert health()['release']==args.release;break
            except Exception:time.sleep(1)
        else:raise RuntimeError('Shield release did not become healthy')
        assert schema()==state['schema'], 'Unexpected schema change; do not roll back blindly'
        assert baseline()=={k:state[k] for k in baseline()}, 'Unrelated runtime configuration changed'
    except Exception:
        # Only roll back an app release while the prior schema is still intact.
        if schema()==state['schema']:
            new.symlink_to(previous);os.replace(new,current);run('systemctl','restart','shield-api')
        raise
    print(json.dumps({'release':args.release,'GPS_and_nginx':'unchanged','schema':state['schema']}))

if __name__=='__main__':main()
