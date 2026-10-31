"""Guarded final-regression web release after location-storage; no API restart or DB write."""
import hashlib,json,os,pathlib,shutil,subprocess,tarfile,urllib.request
from release_assets import inherit_immutable_assets

stage=pathlib.Path('/home/mmm/gps-artifacts/gps-final-20261031-r1')
m=json.loads((stage/'manifest.json').read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
api=pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
web=pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
env=pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
nginx=pathlib.Path('/etc/nginx/sites-available/gps.serial.kr')
assert m['release']=='gps-final-20261031-r1'
assert m['api_release']=='location-storage-20261031-r1'
assert sha(api)==m['api_sha256']=='25d9635292e6c8aab3a686e81a165a9d03e8984f8776234fa531902c9b108997'
assert sha(stage/'web.tar.gz')==m['archive_sha256']
assert sha(stage/'source-final.tar.gz')==m['source_sha256']
assert json.loads((web/'version.json').read_text())['git_commit']=='4b6bbaf958f6d3bdf53a097a6d50eedcdc9e45e5'
assert json.loads((stage/'validation.json').read_text())['web_tests']==196
def get(path):
 with urllib.request.urlopen('https://gps.serial.kr'+path,timeout=20) as r:return r.read()
def guards():
 return {'api':sha(api),'env':sha(env),'nginx':sha(nginx),
         'dev_api':sha(pathlib.Path('/home/gps-dev/projects/gps-tracker-api/bin/gps-tracker-api-dev')),
         'dev_web':str(pathlib.Path('/home/gps-dev/gps-tracker-web-dev/dist').resolve()),
         'shield':str(pathlib.Path('/srv/shield/current').resolve()),
         'processes':subprocess.check_output(['systemctl','show','gps-tracker-api','gps-tracker-api-dev','shield-api','-p','MainPID','-p','ActiveEnterTimestamp']).decode()}
assert shutil.disk_usage(stage).free >= 1024**3, 'At least 1 GiB available is required'
baseline=guards();previous=web.resolve()
target=pathlib.Path('/home/mmm/releases')/m['release'];target.mkdir()
dest=target/'web';dest.mkdir()
with tarfile.open(stage/'web.tar.gz') as t:
 for item in t.getmembers():assert (dest/item.name).resolve().is_relative_to(dest) and (item.isfile() or item.isdir())
 t.extractall(dest)
for name,h in m['web_files'].items():assert (dest/name).resolve().is_relative_to(dest) and sha(dest/name)==h
assert b'"/assets/' in (dest/'index.html').read_bytes()
inherited=inherit_immutable_assets(web/'assets',dest/'assets')
if (web/'uploads').is_symlink():(dest/'uploads').symlink_to((web/'uploads').resolve(),target_is_directory=True)
(dest/'version.json').write_text(json.dumps(dict(m,target='production'),indent=2))
for name in ('manifest.json','validation.json'):shutil.copy2(stage/name,target/name)
(target/'previous-web.txt').write_text(str(previous))
(target/'baseline.json').write_text(json.dumps(baseline,indent=2))
for root,dirs,files in os.walk(target):
 pathlib.Path(root).chmod(0o755)
 for name in files:
  p=pathlib.Path(root)/name
  if not p.is_symlink() and (p.parent!=dest/'assets' or p.relative_to(dest).as_posix() in m['web_files']):p.chmod(0o644)
nextweb=web.with_name('dist-root.next-print')
assert not nextweb.exists() and not nextweb.is_symlink()
diagnostics={p:hashlib.sha256(get(p)).hexdigest() for p in ('/diagnostic','/diagnostic/device')}
try:
 nextweb.symlink_to(dest,target_is_directory=True);os.replace(nextweb,web)
 assert json.loads(get('/version.json'))['git_commit']==m['git_commit']
 for name,h in m['web_files'].items():assert hashlib.sha256(get('/'+name)).hexdigest()==h
 for path in ('/','/corporate','/rentcar','/devices','/profile'):assert hashlib.sha256(get(path)).hexdigest()==sha(dest/'index.html')
 for path,h in diagnostics.items():assert hashlib.sha256(get(path)).hexdigest()==h
 health=json.loads(get('/health'));assert health['ok'] and health['db'] and health['release']==m['api_release']
 assert guards()==baseline
 result={'release':m['release'],'web_commit':m['git_commit'],'api_release':m['api_release'],'api_unchanged':True,'neighbors_unchanged':True,'previous_web':str(previous),'inherited_assets':inherited}
 (target/'deployment.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
except Exception:
 if nextweb.is_symlink():nextweb.unlink()
 nextweb.symlink_to(previous,target_is_directory=True);os.replace(nextweb,web)
 raise
