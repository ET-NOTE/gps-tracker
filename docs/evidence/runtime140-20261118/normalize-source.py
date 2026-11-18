from pathlib import Path
import tarfile,hashlib,json,subprocess
job=Path('/home/etcom-hub/build/gps-runtime140-20261118')
assert Path.cwd()==job and subprocess.check_output(['hostname'],text=True).strip()=='etcom-hub'
changed=[];checked=0;rust_changes=[]
with tarfile.open(job/'source140-final.tar') as tar:
 commit=tar.pax_headers['comment']
 for entry in tar:
  if not entry.isfile():continue
  assert '..' not in Path(entry.name).parts and entry.name.startswith(('ops/','gps-tracker-api/','gps-tracker-web/'))
  target=job/'src'/entry.name;data=tar.extractfile(entry).read();checked+=1
  if target.exists():
   old=target.read_bytes()
   if old==data:continue
   assert old.replace(b'\r\n',b'\n')==data.replace(b'\r\n',b'\n'),'semantic change '+entry.name
   changed.append(entry.name)
   if entry.name.startswith('gps-tracker-api/'):rust_changes.append(entry.name)
  else:assert entry.name=='ops/package_runtime140.py'
  target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
(job/'out/source-normalization140.json').write_text(json.dumps(dict(source_commit=commit,checked_files=checked,newline_only_changes=changed,api_newline_changes=rust_changes,semantic_changes=0),indent=2)+'\n')
print(json.dumps(dict(source_commit=commit,checked=checked,newline_changes=len(changed),api_newline_changes=rust_changes)))
