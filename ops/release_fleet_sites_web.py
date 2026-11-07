"""Guarded web-only follow-up to fleet-sites-20261029-r1; no API restart or DB write."""
import hashlib,json,os,pathlib,shutil,subprocess,tarfile,urllib.request

stage=pathlib.Path('/home/mmm/gps-artifacts/fleet-sites-20261029-r2')
m=json.loads((stage/'manifest.json').read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
api=pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
web=pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
env=pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
nginx=pathlib.Path('/etc/nginx/sites-available/gps.serial.kr')
assert m['release']=='fleet-sites-20261029-r2'
assert m['api_release']=='fleet-sites-20261029-r1'
assert sha(api)==m['api_sha256']=='c1fb7ad22015529956b1f0d03531964a4fcf1a4c4d71240c9a1ed49827f148de'
assert sha(stage/'web.tar.gz')==m['archive_sha256']
assert sha(stage/'source-final.tar.gz')==m['source_sha256']
assert json.loads((web/'version.json').read_text())['git_commit']=='b1724556850046589cd8c6b17cd1f16fdfe6503c'
assert json.loads((stage/'validation.json').read_text())['web_tests']==163
def get(path):
 with urllib.request.urlopen('https://gps.serial.kr'+path,timeout=20) as r:return r.read()
def guards():
 return {'api':sha(api),'env':sha(env),'nginx':sha(nginx),
         'dev_api':sha(pathlib.Path('/home/gps-dev/projects/gps-tracker-api/bin/gps-tracker-api-dev')),
         'dev_web':str(pathlib.Path('/home/gps-dev/gps-tracker-web-dev/dist').resolve()),
         'shield':str(pathlib.Path('/srv/shield/current').resolve()),
         'processes':subprocess.check_output(['systemctl','show','gps-tracker-api','gps-tracker-api-dev','shield-api','-p','MainPID','-p','ActiveEnterTimestamp']).decode()}
baseline=guards();previous=web.resolve()
target=pathlib.Path('/home/mmm/releases')/m['release'];target.mkdir()
dest=target/'web';dest.mkdir()
with tarfile.open(stage/'web.tar.gz') as t:
 for item in t.getmembers():assert (dest/item.name).resolve().is_relative_to(dest) and (item.isfile() or item.isdir())
 t.extractall(dest)
for name,h in m['web_files'].items():assert (dest/name).resolve().is_relative_to(dest) and sha(dest/name)==h
assert b'"/assets/' in (dest/'index.html').read_bytes()
for old in (web/'assets').iterdir():
 if old.is_file() and not (dest/'assets'/old.name).exists():shutil.copy2(old,dest/'assets'/old.name)
if (web/'uploads').is_symlink():(dest/'uploads').symlink_to((web/'uploads').resolve(),target_is_directory=True)
(dest/'version.json').write_text(json.dumps(dict(m,target='production'),indent=2))
for name in ('manifest.json','validation.json'):shutil.copy2(stage/name,target/name)
(target/'previous-web.txt').write_text(str(previous))
(target/'baseline.json').write_text(json.dumps(baseline,indent=2))
for root,dirs,files in os.walk(target):
 pathlib.Path(root).chmod(0o755)
 for name in files:
  p=pathlib.Path(root)/name
  if not p.is_symlink():p.chmod(0o644)
nextweb=web.with_name('dist-root.next-sites')
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
 result={'release':m['release'],'web_commit':m['git_commit'],'api_release':m['api_release'],'api_unchanged':True,'neighbors_unchanged':True,'previous_web':str(previous)}
 (target/'deployment.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
except Exception:
 if nextweb.is_symlink():nextweb.unlink()
 nextweb.symlink_to(previous,target_is_directory=True);os.replace(nextweb,web)
 raise
