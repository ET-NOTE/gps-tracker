#!/usr/bin/env python3
"""Run on etcom-hub. Download with a read-only forced-command SSH key."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import time

ROOT=Path('/home/etcom-hub/backups/shield')
def main():
    os.umask(0o077);ROOT.mkdir(mode=0o700,parents=True,exist_ok=True)
    config=ROOT/'ssh-config'
    assert config.exists()
    temporary=ROOT/'download.partial'
    with temporary.open('wb') as f:
        subprocess.run(['ssh','-F',str(config),'shield-backup'],stdout=f,check=True,timeout=120)
    with tarfile.open(temporary,'r:gz') as tar:
        assert sorted(tar.getnames())==['metadata.json','nginx.conf','shield-api.service','shield.env','shield_prod.dump']
        meta=json.load(tar.extractfile('metadata.json'))
        assert meta['database']=='shield_prod'
        stamp=meta['created_at'];assert re.fullmatch(r'\d{8}T\d{6}Z',stamp)
        created=dt.datetime.strptime(stamp,'%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)
        assert (dt.datetime.now(dt.timezone.utc)-created).total_seconds()<2*86400,'Backup is stale'
    final=ROOT/f'shield-{stamp}.tar.gz'
    os.replace(temporary,final)
    digest=hashlib.sha256(final.read_bytes()).hexdigest()
    final.with_suffix(final.suffix+'.sha256').write_text(digest+'  '+final.name+'\n')
    for file in ROOT.iterdir():
        if re.fullmatch(r'shield-\d{8}T\d{6}Z\.tar\.gz(\.sha256)?',file.name) and file.stat().st_mtime<time.time()-14*86400:
            file.unlink()
    print(json.dumps({'archive':final.name,'sha256':digest,'bytes':final.stat().st_size}))

if __name__=='__main__':main()
