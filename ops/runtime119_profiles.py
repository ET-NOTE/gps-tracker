"""Build-time fixed profiles for the isolated rehearsal images."""
import hashlib
import json
from pathlib import Path

root = Path('/etc/gps119'); root.mkdir()
lib = '/usr/local/lib/gps-nodump.so'
for name, memory in [('api', 550), ('controller', 1024), ('proxy', 64), ('db-memory', 1500), ('db-recovery', 4096), ('db-disk', 1500)]:
    mounts = [{'path': '/tmp', 'max_bytes': 64*1024**2}, {'path': '/dev/shm', 'max_bytes': 64*1024**2}]
    if name in ('db-memory', 'db-recovery'):
        mounts.append({'path': '/var/lib/postgresql/data', 'max_bytes': 1600*1024**2})
    if name == 'db-disk':
        mounts += [{'path': '/gps-temp', 'max_bytes': 256*1024**2},
                   {'path': '/var/lib/postgresql/data/base/pgsql_tmp', 'max_bytes': 64*1024**2}]
    # Keep the 118 verifier unchanged. For non-systemd container profiles this
    # root-owned fixed link attests the generic process temp path, while the
    # exact DB default temp mount is checked above independently.
    plan = dict(library=lib, library_sha256=hashlib.sha256(Path(lib).read_bytes()).hexdigest(),
                mounts=mounts, fallback_link='/etc/gps119/tmp', fallback_target='/tmp',
                memory_max_bytes=memory*1024**2)
    (root/(name+'.json')).write_text(json.dumps(plan))
(root/'tmp').symlink_to('/tmp')
