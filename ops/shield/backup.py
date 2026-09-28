#!/usr/bin/env python3
"""Root-owned daily Shield backup. Retains seven days, never deletes telemetry."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time

ROOT=Path('/var/backups/shield')

def main():
    assert os.geteuid()==0
    os.umask(0o077)
    ROOT.mkdir(mode=0o700,exist_ok=True)
    stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    archive=ROOT/f'shield-{stamp}.tar.gz'
    assert not archive.exists()
    with tempfile.TemporaryDirectory(prefix='work-',dir=ROOT) as tmp:
        work=Path(tmp)
        with (work/'shield_prod.dump').open('wb') as f:
            subprocess.run(['sudo','-u','postgres','pg_dump','-Fc','--no-owner','--no-acl','shield_prod'],stdout=f,check=True)
        subprocess.run(['pg_restore','--list',str(work/'shield_prod.dump')],check=True,stdout=subprocess.DEVNULL)
        for source,name in [('/etc/shield-api/shield.env','shield.env'),('/etc/nginx/sites-available/shield.serial.kr.conf','nginx.conf'),('/etc/systemd/system/shield-api.service','shield-api.service')]:
            shutil.copyfile(source,work/name)
        sql="SELECT json_build_object('users',(SELECT count(*) FROM users),'devices',(SELECT count(*) FROM devices),'readings',(SELECT count(*) FROM readings),'location_records',(SELECT count(*) FROM location_records),'schema_versions',(SELECT json_agg(version ORDER BY version) FROM _sqlx_migrations));"
        counts=json.loads(subprocess.check_output(['sudo','-u','postgres','psql','-XAt','-d','shield_prod','-c',sql],text=True))
        (work/'metadata.json').write_text(json.dumps({'created_at':stamp,'database':'shield_prod','release':Path('/srv/shield/current/release.txt').read_text().strip(),'counts_after_dump':counts},indent=2))
        # The count snapshot is advisory for live databases; quiescent restore tests compare exactly.
        with tarfile.open(str(archive)+'.partial','w:gz') as tar:
            for file in work.iterdir():tar.add(file,arcname=file.name)
        os.replace(str(archive)+'.partial',archive)
    link=ROOT/'latest.new';link.symlink_to(archive.name);os.replace(link,ROOT/'latest.tar.gz')
    for file in ROOT.iterdir():
        if re.fullmatch(r'shield-\d{8}T\d{6}Z\.tar\.gz',file.name) and file!=archive and file.stat().st_mtime<time.time()-7*86400:
            file.unlink()
    h=hashlib.sha256()
    with archive.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    print(json.dumps({'archive':archive.name,'sha256':h.hexdigest(),'bytes':archive.stat().st_size}))

if __name__=='__main__':main()
