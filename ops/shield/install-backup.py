#!/usr/bin/env python3
"""Install bounded Shield backup and certificate reload hooks after approval."""
import os
from pathlib import Path
import re
import shutil
import subprocess

SOURCE=Path(__file__).resolve().parent
def run(*args):subprocess.run(args,check=True)

assert os.geteuid()==0
for source,target in [('backup.py','shield-backup'),('export-backup.py','shield-export-backup')]:
    path=Path('/usr/local/sbin')/target
    assert not path.exists(),str(path)+' already exists'
    shutil.copyfile(SOURCE/source,path);path.chmod(0o700)
for name in ('shield-backup.service','shield-backup.timer'):
    target=Path('/etc/systemd/system')/name
    assert not target.exists()
    shutil.copyfile(SOURCE/name,target);target.chmod(0o644)
key=(SOURCE/'backup-pull-key.pub').read_text().strip()
assert re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+ shield-backup-read-only',key)
authorized=Path('/home/mmm/.ssh/authorized_keys')
line='restrict,command="sudo -n /usr/local/sbin/shield-export-backup" '+key
assert key.split()[1] not in authorized.read_text()
with authorized.open('a') as file:file.write('\n'+line+'\n')
hook=Path('/etc/letsencrypt/renewal-hooks/deploy/50-shield-nginx')
assert not hook.exists()
hook.parent.mkdir(exist_ok=True,parents=True)
hook.write_text('#!/bin/sh\nset -eu\nif [ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/shield.serial.kr ]; then\n  /usr/sbin/nginx -t\n  /bin/systemctl reload nginx\nfi\n')
hook.chmod(0o700)
run('systemd-analyze','verify','/etc/systemd/system/shield-backup.service','/etc/systemd/system/shield-backup.timer')
run('systemctl','daemon-reload')
run('systemctl','start','shield-backup.service')
run('systemctl','enable','--now','shield-backup.timer')
print('Daily local backup and Shield-only certificate renewal reload installed')
