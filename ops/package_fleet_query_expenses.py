"""Package the immutable build and matching Git sources for guarded release."""
import hashlib,json,pathlib,subprocess,tarfile
p=pathlib.Path('C:/Users/msb/AppData/Local/GPS-Builds/fleet-query-expenses-20261031')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
with tarfile.open(p/'web.tar.gz') as t:
 files={m.name.removeprefix('./'):hashlib.sha256(t.extractfile(m).read()).hexdigest() for m in t.getmembers() if m.isfile()}
with tarfile.open(p/'source-final.tar.gz') as t:
 for m in t.getmembers():
  if m.isfile() and m.name.startswith('ops/') and m.name.endswith('.py') and len(pathlib.PurePosixPath(m.name).parts)==2:
   (p/pathlib.PurePosixPath(m.name).name).write_bytes(t.extractfile(m).read())
git=lambda ref:subprocess.check_output(['git','rev-parse',ref],text=True).strip()
commit=git('HEAD');api_commit=git('6ebe3b0')
assert git(commit+':gps-tracker-api')==git(api_commit+':gps-tracker-api'), 'API source differs from validated binary'
manifest={'release':'fleet-query-expenses-20261031-r1','api_release':'fleet-query-expenses-20261031-r1','git_commit':commit,'api_build_commit':api_commit,'api_source_tree':git(api_commit+':gps-tracker-api'),'api_sha256':sha(p/'gps-tracker-api'),'archive_sha256':sha(p/'web.tar.gz'),'source_sha256':sha(p/'source-final.tar.gz'),'web_files':files}
(p/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in manifest.items() if k!='web_files'}))
