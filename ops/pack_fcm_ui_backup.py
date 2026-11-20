"""Pack private release backups for an off-host copy; never print environment data."""
import hashlib
import json
import os
import pathlib
import tarfile
import pwd
backup = pathlib.Path('/home/mmm/backups/gps-fcm-ui-20261008')
output = pathlib.Path('/home/mmm/gps-artifacts/gps-fcm-ui-20261008-backup.tar.gz')
required = ['api.previous','prod.env','nginx.previous','baseline.json','prod-logical.dump',
    'location_records.csv.gz','logical-manifest.json','validation.env','validate.json',
    'api.rollback-schema67','rollback-check.json','web.previous.tar.gz']
assert all((backup / name).is_file() for name in required)
files = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in backup.iterdir()
    if p.is_file() and p.name not in ('backup-hashes.json','offsite-verified.json')}
os.umask(0o077)
(backup/'backup-hashes.json').write_text(json.dumps({'files': files}, indent=2))
with tarfile.open(output, 'w:gz') as archive:
    for name in [*files,'backup-hashes.json']: archive.add(backup/name, arcname=name)
account = pwd.getpwnam('mmm')
os.chown(output, account.pw_uid, account.pw_gid)
output.chmod(0o600)
print(json.dumps({'archive_sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'files':len(files)}))
