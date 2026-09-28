#!/usr/bin/env python3
"""Explicit Shield operations upgrade; no builds or purchases on the VPS.

prepare snapshots the live GPS baseline and proposes exact Shield-only nginx
changes. apply requires a verified offsite Shield backup. Migration rollback is
operator-controlled: never automatically discard readings received after cutover.
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

NGINX=Path('/etc/nginx/sites-available')
CONFIGS=('gps.serial.kr','dev-gps.serial.kr.conf','seriallog.com','shield.serial.kr.conf')
ENV=Path('/etc/shield-api/shield.env')

def run(*args,**kw):return subprocess.check_output(args,text=True,**kw).strip()
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def get(url):
    with urllib.request.urlopen(url,timeout=10) as r:return {'status':r.status,'sha256':hashlib.sha256(r.read()).hexdigest()}
def baseline():return {'binary':sha('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api'),'unit':run('systemctl','show','gps-tracker-api','-p','MainPID','-p','ActiveEnterTimestamp'),'home':get('https://gps.serial.kr/'),'diagnostic':get('https://gps.serial.kr/diagnostic')}
def environment(path):
    return dict(line.split('=',1) for line in path.read_text().splitlines() if line and not line.startswith('#') and '=' in line)
def retire(text,kind):
    if kind=='seriallog.com':
        anchor='    location ^~ /gps-tracker/api/ {'
        assert text.count(anchor)==2
        extra='    location = /gps-tracker/api/v1/shield-monitor { return 410; }\n    location ^~ /gps-tracker/api/v1/shield-monitor/ { return 410; }\n'
        return text.replace(anchor,extra+anchor)
    text,count=re.subn(r'    location = /ingest/shield \{[^}]*\}', '    location = /ingest/shield { return 410; }',text)
    assert count==2, kind+' ingest location count'
    if kind=='gps.serial.kr':
        anchor='    location /api/v1/ {'
        extra='    location = /api/v1/shield-monitor { return 410; }\n    location ^~ /api/v1/shield-monitor/ { return 410; }\n'
        text=text.replace('Shield portal moved. Legacy device ingest remains available until cutover.','Shield moved: retired ingest and monitor APIs; GPS/KC routes unchanged.')
    else:
        anchor='    location ^~ /gps-tracker/api/ {'
        extra='    location = /gps-tracker/api/v1/shield-monitor { return 410; }\n    location ^~ /gps-tracker/api/v1/shield-monitor/ { return 410; }\n'
        text,count=re.subn(r'    location = /arduino-shield \{[^}]*\}', '    location = /arduino-shield { return 302 https://shield.serial.kr/data; }',text)
        assert count==1
        text,count=re.subn(r'    location = /arduino-shield/data \{[^}]*\}', '    location = /arduino-shield/data { return 410; }',text)
        assert count==1
    assert text.count(anchor)==1
    return text.replace(anchor,extra+anchor)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('step',choices=['prepare','apply','verify'])
    p.add_argument('--release',required=True);p.add_argument('--sha256',required=True)
    p.add_argument('--verified-backup-sha256')
    a=p.parse_args();assert os.geteuid()==0;os.umask(0o077)
    assert re.fullmatch(r'shield-\d{8}-\d{6}-[a-f0-9]{7}',a.release)
    assert re.fullmatch(r'[a-f0-9]{64}',a.sha256)
    root=Path('/home/mmm/shield-deploy')/a.release
    archive=root/(a.release+'.tar.gz');assert sha(archive)==a.sha256
    backup=Path('/var/backups/shield-rollout')/a.release
    statefile=backup/'upgrade.json';target=Path('/srv/shield/releases')/a.release
    def save(s):statefile.write_text(json.dumps(s,indent=2))
    if a.step=='prepare':
        assert not backup.exists() and not target.exists()
        assert shutil.disk_usage('/').free>1024**3
        backup.mkdir(mode=0o700);(backup/'proposed').mkdir()
        for name in CONFIGS:shutil.copy2(NGINX/name,backup/name)
        shutil.copy2(ENV,backup/'shield.env')
        with tarfile.open(archive,'r:gz') as tar:
            members=tar.getmembers()
            for m in members:
                path=Path(m.name)
                assert path.parts[0]==a.release and not path.is_absolute() and '..' not in path.parts
                assert m.isfile() or m.isdir()
                m.uid=m.gid=0;m.uname=m.gname='root'
                m.mode=0o755 if m.isdir() or path.name=='shield-api' else 0o644
            tar.extractall(target.parent,members=members)
        run('sha256sum','--check','--status','SHA256SUMS',cwd=target)
        for name in CONFIGS:
            text=(target/'ops/shield.serial.kr.conf').read_text().replace('/var/lib/letsencrypt','/var/www/certbot') if name=='shield.serial.kr.conf' else retire((backup/name).read_text(),name)
            (backup/'proposed'/name).write_text(text)
        dbbackup=Path('/var/backups/shield/latest.tar.gz').resolve()
        s={'phase':'prepared','baseline':baseline(),'previous':str(Path('/srv/shield/current').resolve()),'backup':str(dbbackup),'backup_sha256':sha(dbbackup),'env_sha256':sha(ENV),'config_sha256':{n:sha(NGINX/n) for n in CONFIGS}}
        save(s);print(json.dumps({'phase':s['phase'],'backup_sha256':s['backup_sha256'],'proposals':str(backup/'proposed')}));return
    s=json.loads(statefile.read_text());assert baseline()==s['baseline'],'GPS baseline changed'
    if a.step=='apply':
        assert s['phase']=='prepared' and a.verified_backup_sha256==s['backup_sha256']
        assert sha(s['backup'])==s['backup_sha256']
        assert sha(ENV)==s['env_sha256'] and all(sha(NGINX/n)==h for n,h in s['config_sha256'].items())
        gps=environment(Path('/home/mmm/projects/gps-tracker-api/.env'));env=environment(ENV)
        for src,dst in [('ONCE_API_CLIENT_ID','SHIELD_NCE_CLIENT_ID'),('ONCE_API_CLIENT_SECRET','SHIELD_NCE_CLIENT_SECRET')]:
            assert gps.get(src);env[dst]=gps[src]
        price=gps.get('SIM_TOPUP_COST','143000').strip('"\'');assert price.isdigit() and 0<int(price)<=10000000
        env.update(SHIELD_NCE_API_VERSION='v1',SHIELD_NCE_TOPUP_ENABLED='true',SHIELD_TOPUP_COST=price)
        for n in CONFIGS:shutil.copyfile(backup/'proposed'/n,NGINX/n)
        try:run('nginx','-t')
        except Exception:
            for n in CONFIGS:shutil.copyfile(backup/n,NGINX/n)
            raise
        ENV.write_text(''.join(k+'='+v+'\n' for k,v in env.items()))
        current=Path('/srv/shield/current');new=Path('/srv/shield/current.upgrade')
        assert current.resolve()==Path(s['previous']) and not new.exists()
        new.symlink_to(target);os.replace(new,current)
        s['phase']='migrating';save(s)
        run('systemctl','restart','shield-api')
        for attempt in range(20):
            try:
                health=json.load(urllib.request.urlopen('http://127.0.0.1:3043/health',timeout=3))
                assert health['release']==a.release;break
            except Exception:
                if attempt==19:raise RuntimeError('Shield failed readiness; inspect journal and saved backup, do not blindly roll back schema')
                time.sleep(1)
        run('systemctl','reload','nginx');s['phase']='active';save(s)
    assert s['phase']=='active'
    assert baseline()==s['baseline'],'GPS baseline changed after upgrade'
    print(json.dumps({'phase':s['phase'],'release':a.release,'GPS_KC_baseline':'unchanged','purchases_sent':0}))

if __name__=='__main__':main()
