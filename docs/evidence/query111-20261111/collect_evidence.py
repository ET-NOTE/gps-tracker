import base64,hashlib,json,pathlib,shutil,tarfile
root=pathlib.Path('/home/etcom-hub/build')
perf=root/'gps-provision22-20261111query111'; job=root/'gps-provision22-20261111cumulative111'
dest=job/'evidence-query111'
dest.mkdir(exist_ok=True)
secrets=[]
for folder in (perf,job):
 ring=json.loads((folder/'test-keys.json').read_text())
 for key in ring['keys'].values():
  secrets.extend([key.encode(),base64.b64decode(key),base64.b64decode(key).hex().encode()])
 cred=json.loads((folder/'test-runtime.json').read_text())
 secrets.append(cred['password'].encode())
for folder in (perf,job):
 for path in sorted((folder/'out').iterdir()):
  if path.suffix not in ('.json','.log'):continue
  assert path.stat().st_size<5_000_000,path.name
  target=dest/path.name
  if target.exists() and target.read_bytes()!=path.read_bytes():
   raise AssertionError('conflicting evidence '+path.name)
  data=path.read_bytes()
  assert not any(secret in data for secret in secrets),'private test credential in '+path.name
  shutil.copy2(path,target)
for path in sorted(job.glob('*.py')):
 shutil.copy2(path,dest/path.name)
shutil.copy2(job/'dev22.sh',dest/'dev22.sh')
for name in ['recheck_load.py','reconcile111.py','finalize_source.py','revise_candidate.py','stop_retired_connections.py']:
 if (perf/name).is_file():shutil.copy2(perf/name,dest/name)
for path in dest.iterdir():
 assert path.is_file()
 assert not any(secret in path.read_bytes() for secret in secrets),'private test credential in '+path.name
(dest/'evidence-secret-check.json').write_text(json.dumps({'scanned_files':len(list(dest.iterdir())),
 'generated_keys_and_runtime_passwords_absent':True,'production_credentials_used':False},indent=2)+'\n')
print('EVIDENCE COLLECTED AND SECRET SCANNED',len(list(dest.iterdir())))
