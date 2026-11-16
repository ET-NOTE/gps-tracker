"""Freeze exact verified135 source/API/web/evidence; not a production installer."""
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile

JOB=Path('/home/etcom-hub/build/gps-runtime135-20261116')
assert subprocess.check_output(['hostname'],text=True).strip()=='etcom-hub' and Path.cwd()==JOB
commit=sys.argv[1]
assert re.fullmatch('[0-9a-f]{40}',commit)
sha=lambda data:hashlib.sha256(data).hexdigest()
archive=JOB/'candidate-runtime135-20261116-r1.tar.gz'
assert not archive.exists()
files={}
with tarfile.open(JOB/'source135-final.tar') as source:
    assert source.pax_headers.get('comment')==commit
    for entry in source:
        if not entry.isfile():continue
        assert entry.name.startswith(('ops/','gps-tracker-api/','gps-tracker-web/'))
        assert '..' not in Path(entry.name).parts and not entry.name.startswith('/')
        data=source.extractfile(entry).read()
        assert (JOB/'src'/entry.name).read_bytes()==data, 'Verified source differs: '+entry.name
        files['sources/'+entry.name]=data
for path in (JOB/'src/gps-tracker-web/dist').rglob('*'):
    if path.is_file():files['web/'+str(path.relative_to(JOB/'src/gps-tracker-web/dist'))]=path.read_bytes()
binary=(JOB/'out/gps-tracker-api135').read_bytes()
assert binary==(JOB/'out/gps-tracker-api').read_bytes()
result=json.loads((JOB/'out/functional135.json').read_text())
assert sha(binary)==result['api_sha256'] and len(result['passed'])==7
files['api/gps-tracker-api']=binary
files['evidence135.tar.gz']=(JOB/'evidence135.tar.gz').read_bytes()
manifest=dict(source_commit=commit,schema=114,activation_ready=False,production_accessed=False,
    purpose='Company mapping pagination and status filters; historical binding correction; no expanded/sustained load',
    api_sha256=sha(binary),dependencies={
        'prior_candidate134':'d02ab5b3ce31fe9d9d05f52f87faa8e7bb3df0c257eafe2e54852df7c83b639b',
        'cumulative_recovery128':'f9eae87e2429ba1035e370a1d75c179caa5c82d2b830de0999d58f3e01604fbc'},
    files={name:dict(bytes=len(data),sha256=sha(data)) for name,data in sorted(files.items())})
files['manifest.json']=json.dumps(manifest,indent=2).encode()
with tarfile.open(archive,'w:gz') as tar:
    for name,data in sorted(files.items()):
        info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o755 if name.startswith('api/') else 0o644
        tar.addfile(info,io.BytesIO(data))
with tarfile.open(archive) as tar:
    for entry in tar:assert tar.extractfile(entry).read()==files[entry.name]
result=dict(archive=str(archive),bytes=archive.stat().st_size,sha256=sha(archive.read_bytes()),files=len(files),
    source_commit=commit,api_sha256=sha(binary),schema=114,activation_ready=False,archive_readback_verified=True,
    web_files={name:sha(data) for name,data in files.items() if name.startswith('web/')})
(JOB/'out/candidate-manifest135.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result),flush=True)
