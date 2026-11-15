"""Export allowlisted synthetic evidence, rejecting actual fixture credentials."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile

JOB=Path('/home/etcom-hub/build/gps-runtime127-20261115')
ROOT=JOB/'out'
assert subprocess.check_output(['hostname'],text=True).strip()=='etcom-hub' and Path.cwd()==JOB
items=[]
for path in ROOT.rglob('*'):
    if not path.is_file():continue
    rel=path.relative_to(ROOT)
    if len(rel.parts)==1 and path.suffix in ('.json','.jsonl','.log','.txt'):items.append(path)
    elif rel.parts[0]=='units' or (rel.parts[0]=='adapters' and path.suffix in ('.json','.py')):items.append(path)
assert items and all(not any(s in p.name.lower() for s in ('keyring','password','.env','test-runtime','restore126-private')) for p in items)


def private(name):
    return json.loads(subprocess.check_output(['docker','exec','gps-runtime127-host','cat','/opt/gps121/'+name]))


secrets=list(private('test-keys.json')['keys'].values())+[private('test-runtime.json')['password']]
for path in items:
    assert all(secret.encode() not in path.read_bytes() for secret in secrets),('credential found',path.name)
index={p.relative_to(ROOT).as_posix():dict(bytes=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(items)}
check=JOB/'remote-byte-check.json'
check.write_text(json.dumps(dict(source=str(ROOT),synthetic=True,production_modified=False,
    credential_scan_passed=True,files=index),indent=2))
archive=JOB/'evidence127.tar.gz'
assert not archive.exists(),'Evidence export is immutable; use a new revision'
with tarfile.open(archive,'w:gz') as tar:
    for path in items:tar.add(path,arcname=path.relative_to(ROOT).as_posix())
    tar.add(check,arcname='remote-byte-check.json')
print(json.dumps(dict(files=len(items),bytes=sum(v['bytes'] for v in index.values()),
    archive_sha256=hashlib.sha256(archive.read_bytes()).hexdigest())),flush=True)
