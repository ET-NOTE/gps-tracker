"""Read-only final reconciliation after labelled121 teardown; no production."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tarfile
from datetime import datetime, timezone

JOB=Path('/home/etcom-hub/build/gps-runtime121-20261113')
assert Path.cwd()==JOB
sys.path.insert(0,str(JOB/'src/ops'))
from rehearse_runtime121 import HOST,NET,guard,call
from build_cleanup_20261113 import containers,REQUIRED,sha
guard()
assert call('docker','inspect',HOST,check=False).returncode!=0
assert call('docker','network','inspect',NET,check=False).returncode!=0
baseline=json.loads((JOB/'baseline-containers.json').read_text())
actual=containers()
assert actual==baseline['containers'], 'Unrelated container changed; inspect before claiming unchanged'
for name,digest in REQUIRED.items():
    assert sha(JOB.parent/name)==digest,name
manifest=json.loads((JOB/'out/candidate-manifest121.json').read_text())
assert sha(Path(manifest['archive']))==manifest['archive_sha256']
checked=0
with tarfile.open(JOB/'ops.tar') as archive:
    for member in archive.getmembers():
        if member.isfile():
            assert member.name.startswith('ops/')
            assert archive.extractfile(member).read()==(JOB/'src'/member.name).read_bytes(),member.name
            checked+=1
result=dict(at=datetime.now(timezone.utc).isoformat(),container_removed=HOST,network_removed=NET,
    unrelated_containers=len(actual),container_state_unchanged_since=baseline['at'],
    protected_prior_artifact_hashes=len(REQUIRED),canonical_source_files_checked=checked,
    source_commit=manifest['source_commit'],candidate_sha256=manifest['archive_sha256'],
    build_free_bytes=shutil.disk_usage(JOB).free,production_contacted=False,
    credentials_dumps_synthetic_database_removed_with_container=True,automatic_retention_added=False)
(JOB/'out/cleanup121.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
