from pathlib import Path
import tarfile,json,hashlib,subprocess
job=Path('/home/etcom-hub/build/gps-runtime140-20261118')
assert Path.cwd()==job
files=0
with tarfile.open(job/'source140-final.tar') as tar:
 commit=tar.pax_headers['comment']
 for p in tar:
  if not p.isfile():continue
  assert '..' not in Path(p.name).parts
  assert tar.extractfile(p).read()==(job/'src'/p.name).read_bytes(),p.name
  files+=1
result={'source_commit':commit,'files':files,'exact_byte_match':True,'api_sha256':hashlib.sha256((job/'out/gps-tracker-api140').read_bytes()).hexdigest()}
(job/'out/source-final140.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
with tarfile.open(job/'raw-evidence140.tar.gz','w:gz') as tar:
 for p in sorted((job/'out').iterdir()):
  if p.is_file() and (p.suffix in ('.json','.log') or p.name.endswith('-functional-source.py')):tar.add(p,arcname=p.name)
