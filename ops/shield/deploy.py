#!/usr/bin/env python3
"""Explicitly approved Shield rollout. Run as root on the seriallog VPS.

Steps are separate so the verified offsite backup precedes any configuration change.
No GPS binary, firmware or ingest route is replaced.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import subprocess
import tarfile
import time
import urllib.request

def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()

def pg(sql, db='postgres'):
    return run('sudo','-u','postgres','psql','-XAt','-v','ON_ERROR_STOP=1','-d',db,input=sql)

def digest(path):
    with open(path,'rb') as f:
        result=hashlib.sha256()
        for chunk in iter(lambda:f.read(1024*1024),b''):
            result.update(chunk)
        return result.hexdigest()

def health(url):
    with urllib.request.urlopen(url,timeout=15) as r:
        body=r.read()
        return {'status':r.status,'sha256':hashlib.sha256(body).hexdigest()}

def ready(url):
    # A graceful nginx reload returns before the new workers accept connections.
    for attempt in range(10):
        try:
            return health(url)
        except Exception:
            if attempt==9:raise
            time.sleep(1)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('step',choices=['prepare','install','challenge','activate','retire-page','verify'])
    parser.add_argument('--release',required=True)
    parser.add_argument('--sha256',required=True)
    args=parser.parse_args()
    assert os.geteuid()==0
    assert re.fullmatch(r'shield-\d{8}-\d{6}-[a-f0-9]{7}',args.release)
    assert re.fullmatch(r'[a-f0-9]{64}',args.sha256)
    incoming=Path('/home/mmm/shield-deploy')/args.release
    archive=incoming/(args.release+'.tar.gz')
    backup=Path('/var/backups/shield-rollout')/args.release
    statefile=backup/'state.json'
    target=Path('/srv/shield/releases')/args.release
    gps=Path('/etc/nginx/sites-available/gps.serial.kr')
    shield=Path('/etc/nginx/sites-available/shield.serial.kr.conf')
    enabled=Path('/etc/nginx/sites-enabled/shield.serial.kr.conf')
    assert digest(archive)==args.sha256, 'Artifact digest mismatch'
    def save(state):statefile.write_text(json.dumps(state,indent=2))
    if args.step=='prepare':
        assert not statefile.exists(), 'Backup already exists; inspect it before continuing'
        assert shutil.disk_usage('/').free>2*1024**3, 'Insufficient free space for staging and rollback'
        backup.mkdir(parents=True,mode=0o700)
        hba=Path(pg('SHOW hba_file;'))
        shutil.copy2(hba,backup/'pg_hba.conf')
        shutil.copy2(gps,backup/'gps.serial.kr')
        run('tar','-czf',str(backup/'nginx-config.tar.gz'),'-C','/etc','nginx')
        with open(backup/'gps_tracker.dump','wb') as stream:
            subprocess.run(['sudo','-u','postgres','pg_dump','-Fc','gps_tracker'],stdout=stream,check=True)
        state={'release':args.release,'artifact_sha256':args.sha256,'hba_path':str(hba),
               'gps_binary_sha256':digest('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api'),
               'gps_root':health('https://gps.serial.kr/'),
               'diagnostic':health('https://gps.serial.kr/diagnostic'),
               'gps_unit':run('systemctl','show','gps-tracker-api','-p','MainPID','-p','ActiveEnterTimestamp'),
               'gps_nginx_sha256':digest(gps),'hba_sha256':digest(hba), 'phase':'prepared'}
        save(state)
        out=incoming/'backup.tar.gz'
        with tarfile.open(out,'w:gz') as tar:
            tar.add(backup,arcname=backup.name)
        os.chown(out,pwd.getpwnam('mmm').pw_uid,pwd.getpwnam('mmm').pw_gid);out.chmod(0o600)
        print(json.dumps({'backup':str(out),'sha256':digest(out),'baseline':state}))
        return
    state=json.loads(statefile.read_text())
    assert state['artifact_sha256']==args.sha256
    assert digest('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')==state['gps_binary_sha256'], 'GPS binary changed since baseline'
    if args.step=='install':
        if not target.exists():
            target.parent.mkdir(parents=True,exist_ok=True)
            with tarfile.open(archive,'r:gz') as tar:
                members=tar.getmembers()
                for member in members:
                    name=Path(member.name)
                    assert name.parts and name.parts[0]==args.release
                    assert not name.is_absolute() and '..' not in name.parts
                    assert member.isfile() or member.isdir(), 'Only regular files and directories are allowed'
                    member.uid=member.gid=0
                    member.uname=member.gname='root'
                    member.mode=0o755 if member.isdir() or name.name=='shield-api' else 0o644
                # Validated above; compatible with Ubuntu 22.04's Python 3.10.
                tar.extractall(target.parent,members=members)
        run('sha256sum','--check','--status','SHA256SUMS',cwd=target)
        if subprocess.run(['id','gps-shield'],capture_output=True).returncode:
            run('useradd','--system','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin','gps-shield')
        user=pwd.getpwnam('gps-shield')
        envdir=Path('/etc/shield-api');envdir.mkdir(mode=0o750,exist_ok=True);os.chown(envdir,0,user.pw_gid)
        envfile=envdir/'shield.env'
        if not envfile.exists():
            assert pg("SELECT count(*) FROM pg_roles WHERE rolname='shield_app';")=='0'
            assert pg("SELECT count(*) FROM pg_database WHERE datname='shield_prod';")=='0'
            password=secrets.token_hex(32)
            with os.fdopen(os.open(envfile,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as stream:
                stream.write(f'SHIELD_ENV=production\nSHIELD_ORIGIN=https://shield.serial.kr\nSHIELD_BIND=127.0.0.1:3043\nSHIELD_DATABASE_URL=postgres://shield_app:{password}@127.0.0.1:5432/shield_prod\nRUST_LOG=shield_api=info,sqlx=warn\n')
            envfile.chmod(0o640);os.chown(envfile,0,user.pw_gid)
            pg(f"\\set shield_password '{password}'\n"+(target/'ops/bootstrap-database.sql').read_text())
        hba=Path(state['hba_path']);fragment=(target/'ops/postgres-hba.fragment').read_text()
        if not hba.read_text().startswith(fragment):
            assert digest(hba)==state['hba_sha256'], 'HBA changed since backup'
            hba.write_text(fragment+'\n'+hba.read_text())
            errors=pg('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;')
            if errors!='0':
                shutil.copy2(backup/'pg_hba.conf',hba)
                raise RuntimeError('HBA parse failed; original file restored')
            pg('SELECT pg_reload_conf();')
        current=Path('/srv/shield/current')
        assert not current.exists() or current.resolve()==target
        if not current.exists():current.symlink_to(target)
        shutil.copy2(target/'ops/shield-api.service','/etc/systemd/system/shield-api.service')
        run('systemd-analyze','verify','/etc/systemd/system/shield-api.service')
        run('systemctl','daemon-reload');run('systemctl','enable','--now','shield-api')
        for _ in range(20):
            try:
                value=json.load(urllib.request.urlopen('http://127.0.0.1:3043/health',timeout=3))
                assert value['release']==args.release;break
            except Exception:time.sleep(1)
        else:raise RuntimeError('Shield did not become ready; GPS remains unchanged')
        state['phase']='installed';save(state)
        print(json.dumps({'phase':'installed','health':value}))
    elif args.step=='challenge':
        assert state['phase']=='installed' and not shield.exists() and not enabled.exists()
        shield.write_text('server { listen 80; server_name shield.serial.kr; location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; try_files $uri =404; } location / { return 503; } }\n')
        enabled.symlink_to(shield)
        try:run('nginx','-t')
        except Exception:
            enabled.unlink();raise
        run('systemctl','reload','nginx')
        state['phase']='challenge';save(state);print('ACME-only Shield virtual host active')
    elif args.step=='activate':
        assert Path('/etc/letsencrypt/live/shield.serial.kr/fullchain.pem').exists()
        old=shield.read_text()
        config=(target/'ops/shield.serial.kr.conf').read_text().replace('/var/lib/letsencrypt','/var/www/certbot')
        shield.write_text(config)
        try:run('nginx','-t')
        except Exception:
            shield.write_text(old);raise
        run('systemctl','reload','nginx')
        state['phase']='active';save(state)
        print(json.dumps({'shield':ready('https://shield.serial.kr/')}))
    elif args.step=='retire-page':
        assert state['phase']=='active'
        assert health('https://shield.serial.kr/')['status']==200
        before=gps.read_text()
        assert digest(gps)==state['gps_nginx_sha256'], 'GPS nginx changed since backup'
        start=before.index('    # Dedicated UNO monitor;')
        end=before.index('    location /diagnostic',start)
        replacement='''    # Shield portal moved. Legacy device ingest remains available until cutover.
    location = /arduino-shield { return 302 https://shield.serial.kr/data; }
    location = /arduino-shield/ { return 302 https://shield.serial.kr/data; }
    location = /arduino-shield/data { return 410; }

'''
        gps.write_text(before[:start]+replacement+before[end:])
        try:run('nginx','-t')
        except Exception:
            gps.write_text(before);raise
        run('systemctl','reload','nginx')
        state['phase']='page-retired';save(state);print('GPS Shield page redirected; legacy ingest and KC diagnostic unchanged')
    elif args.step=='verify':
        result={'phase':state['phase'],'shield':health('https://shield.serial.kr/'),
                'gps_root_unchanged':health('https://gps.serial.kr/')==state['gps_root'],
                'diagnostic_unchanged':health('https://gps.serial.kr/diagnostic')==state['diagnostic'],
                'gps_process_unchanged':run('systemctl','show','gps-tracker-api','-p','MainPID','-p','ActiveEnterTimestamp')==state['gps_unit'],
                'gps_binary_unchanged':digest('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')==state['gps_binary_sha256']}
        assert all(result[k] for k in result if k.endswith('_unchanged'))
        (backup/'verification.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))

if __name__=='__main__':main()
