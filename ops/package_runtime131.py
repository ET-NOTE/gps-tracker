"""Immutable131 source/binary/evidence package. Not a production installer."""
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile

JOB=Path('/home/etcom-hub/build/gps-runtime131-20261115')
assert subprocess.check_output(['hostname'],text=True).strip()=='etcom-hub' and Path.cwd()==JOB
commit=sys.argv[1];baseline_commit=sys.argv[2]
assert all(re.fullmatch('[0-9a-f]{40}',s) for s in (commit,baseline_commit))
archive=JOB/'candidate-runtime131-20261115-r1.tar.gz';assert not archive.exists()
sha=lambda data:hashlib.sha256(data).hexdigest()
files={}
for source_name,prefix in [('source131-final.tar','sources/'),('source131-baseline.tar','baseline-sources/')]:
    with tarfile.open(JOB/source_name) as source:
        assert source.pax_headers.get('comment')==(commit if prefix=='sources/' else baseline_commit), 'Archive commit must match manifest'
        for entry in source:
            if not entry.isfile():continue
            assert entry.name.startswith(('ops/','gps-tracker-api/')) and not entry.name.startswith('/') and '..' not in Path(entry.name).parts
            files[prefix+entry.name]=source.extractfile(entry).read()
assert len(files)>600
adjustments={}
for variant,prefix in [('baseline','baseline-sources/'),('candidate','sources/')]:
    hashes=json.loads((JOB/('source131-'+variant+'.json')).read_text())
    for name,digest in hashes.items():
        data=files[prefix+name]
        assert sha(files[prefix+name])==digest,(variant,name)
for path in (JOB/'canonical/gps-tracker-api/migrations').glob('*.sql'):
    assert files['sources/gps-tracker-api/migrations/'+path.name]==path.read_bytes()
for name,digest in json.loads((JOB/'out/running-source131.json').read_text()).items():
    assert sha(files['sources/ops/'+name])==digest,name
for path in (JOB/'src/ops').glob('*131.py'):
    assert files['sources/ops/'+path.name]==path.read_bytes(),path.name
baseline=(JOB/'gps-tracker-api131-baseline').read_bytes()
binary=(JOB/'gps-tracker-api131-candidate').read_bytes()
assert baseline!=binary and binary==(JOB/'out/gps-tracker-api').read_bytes()
assert sha(binary)==json.loads((JOB/'out/final131.json').read_text())['api_sha256']
files['api/gps-tracker-api']=binary;files['api/gps-tracker-api-baseline']=baseline
for name in ('evidence131.tar.gz',):
    files[name]=(JOB/name).read_bytes()
files['host-after.json']=(JOB/'out/host-after.json').read_bytes()
manifest=dict(source_commit=commit,baseline_source_commit=baseline_commit,baseline_source_adjustments=adjustments,schema=114,activation_ready=False,production_modified=False,
    purpose='monthly endpoint pair reads and ordered trip ranges; bounded functional/300s regression, not a production installer',
    api_sha256=sha(binary),baseline_api_sha256=sha(baseline),dependencies={
        'candidate-runtime130-20261115-r1.tar.gz':'0759789c07f40a471e19a7f0b477be333f714b64e4dad6393970b95a32ef7f76',
        'candidate-runtime129-20261115-r1.tar.gz':'4b0d40965b60cd9081149ac72bc7eba96f9a7510934a56ff7a9dd2c64cedf6bd',
        'candidate-runtime128-20261115-r1.tar.gz':'f9eae87e2429ba1035e370a1d75c179caa5c82d2b830de0999d58f3e01604fbc',
        'candidate-runtime127-20261115-r1.tar.gz':'2d4975611671b93eca2b47dec2fc3824ca7f511a0fa1aa5f95ab76ace02fdf3e',
        'recovery-kit-runtime125-20261114-r1.tar.gz':'f469828ce877ffffa555fe9b168200c7e423c0e1228f9a858df5218f67ec6c73',
        'candidate-runtime124-20261114-r1.tar.gz':'353c16488c7f4aa0fb6cbc264ab0a30f9330ec0fe875ae59208c8be9ec195649'},
    files={name:dict(bytes=len(data),sha256=sha(data)) for name,data in sorted(files.items())})
files['manifest.json']=json.dumps(manifest,indent=2).encode()
with tarfile.open(archive,'w:gz') as tar:
    for name,data in sorted(files.items()):
        info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o755 if name.startswith('api/') else 0o644
        tar.addfile(info,io.BytesIO(data))
with tarfile.open(archive) as tar:
    for entry in tar:assert tar.extractfile(entry).read()==files[entry.name]
result=dict(archive=str(archive),bytes=archive.stat().st_size,sha256=sha(archive.read_bytes()),
    files=len(files),source_commit=commit,baseline_source_commit=baseline_commit,api_sha256=sha(binary),baseline_api_sha256=sha(baseline),
    schema=114,activation_ready=False,archive_readback_verified=True,baseline_source_adjustments=adjustments,dependencies=manifest['dependencies'])
(JOB/'out/candidate-manifest131.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result),flush=True)
