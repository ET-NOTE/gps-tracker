"""Immutable128 recovery inputs. Not a production installer or activation gate."""
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile

JOB=Path('/home/etcom-hub/build/gps-runtime128-20261115')
assert subprocess.check_output(['hostname'],text=True).strip()=='etcom-hub' and Path.cwd()==JOB
commit=sys.argv[1];assert re.fullmatch('[0-9a-f]{40}',commit)
archive=JOB/'candidate-runtime128-20261115-r1.tar.gz'
assert not archive.exists()
sha=lambda data:hashlib.sha256(data).hexdigest()
files={}
with tarfile.open(JOB/'source128-final.tar') as source:
    for entry in source:
        if not entry.isfile():continue
        if entry.name.startswith(('ops/','gps-tracker-api/')):
            assert not entry.name.startswith('/') and '..' not in Path(entry.name).parts
            files['sources/'+entry.name]=source.extractfile(entry).read()
assert len(files)>400
# Check the actual built migration bytes, including all114 historical inputs.
for path in (JOB/'canonical/gps-tracker-api/migrations').glob('*.sql'):
    assert files['sources/gps-tracker-api/migrations/'+path.name]==path.read_bytes()
assert files['sources/gps-tracker-api/migrations/0114_location_single_scan.sql']==(JOB/'src/gps-tracker-api/migrations/0114_location_single_scan.sql').read_bytes()
for name in ('admin_db_roles.py','crypto20b_transition.py','location_storage.py','location_query_bounds.py','location_query_statistics.py'):
    assert files['sources/ops/'+name]==(JOB/'src/ops'/name).read_bytes(),name
binary=(JOB/'out/gps-tracker-api').read_bytes()
assert sha(binary)=='5c6f4529207f9ab0d5d30598dbb4fe8a4e4b77dc4e5304a8736f311fdcdb7e52'
files['api/gps-tracker-api']=binary
files['evidence128.tar.gz']=(JOB/'evidence128.tar.gz').read_bytes()
files['host-after.json']=(JOB/'out/host-after.json').read_bytes()
manifest=dict(source_commit=commit,schema=114,activation_ready=False,production_modified=False,
    purpose='isolated reproduction and recovery inputs; not a production installer',
    api_sha256=sha(binary),api_reused_from_round=127,dependencies={
        'candidate-runtime127-20261115-r1.tar.gz':'2d4975611671b93eca2b47dec2fc3824ca7f511a0fa1aa5f95ab76ace02fdf3e',
        'recovery-kit-runtime125-20261114-r1.tar.gz':'f469828ce877ffffa555fe9b168200c7e423c0e1228f9a858df5218f67ec6c73',
        'candidate-runtime124-20261114-r1.tar.gz':'353c16488c7f4aa0fb6cbc264ab0a30f9330ec0fe875ae59208c8be9ec195649'},
    files={name:dict(bytes=len(data),sha256=sha(data)) for name,data in sorted(files.items())})
payload=json.dumps(manifest,indent=2).encode();files['manifest.json']=payload
with tarfile.open(archive,'w:gz') as tar:
    for name,data in sorted(files.items()):
        info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o755 if name=='api/gps-tracker-api' else 0o644
        tar.addfile(info,io.BytesIO(data))
with tarfile.open(archive) as tar:
    for entry in tar:
        assert tar.extractfile(entry).read()==files[entry.name]
result=dict(archive=str(archive),bytes=archive.stat().st_size,sha256=sha(archive.read_bytes()),
    files=len(files),source_commit=commit,api_sha256=sha(binary),schema=114,activation_ready=False,
    archive_readback_verified=True,dependencies=manifest['dependencies'])
(JOB/'out/candidate-manifest128.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result),flush=True)
