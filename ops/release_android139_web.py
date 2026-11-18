"""139 web-only cutover. Pinned baseline, verified archive, atomic link, rollback.

Run as root with stage /home/mmm/gps-artifacts/android139-web-20261118-r1.
Does not restart API/DB or change configuration, flags, dev source, or firewall.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from release_assets import inherit_immutable_assets

stage = Path(sys.argv[1]).resolve()
assert stage == Path('/home/mmm/gps-artifacts/android139-web-20261118-r1')
manifest = json.loads((stage/'manifest.json').read_text())
assert manifest['release'] == 'android139-web-20261118-r1'
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
get = lambda path: urllib.request.urlopen('https://gps.serial.kr'+path, timeout=30).read()
link = Path('/home/mmm/gps-tracker-web/dist-root')
previous = Path('/home/mmm/releases/review137-20261116-r2/web')
assert link.is_symlink() and link.resolve() == previous
assert json.loads(get('/health'))['release'] == 'review137-20261116-r3'
assert sha(stage/'web.tar.gz') == manifest['archive_sha256']
assert shutil.disk_usage('/home/mmm').free > 1024**3

def snapshot():
    paths = ['/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api',
             '/home/mmm/projects/gps-tracker-api/.env',
             '/home/gps-dev/gps-tracker-web-dev/dist/index.html']
    return {'files': {p:sha(p) for p in paths},
            'services': {name:subprocess.check_output(['systemctl','show',name,'--property=MainPID,ActiveState,ExecMainStartTimestamp'],text=True)
                         for name in ['gps-tracker-api','gps-tracker-api-dev','nginx','postgresql','gps-pdf-render.socket']},
            'health':json.loads(get('/health'))}

before=snapshot()
target=Path('/home/mmm/releases')/manifest['release']
assert not target.exists()
web=target/'web';web.mkdir(parents=True,mode=0o755)
with tarfile.open(stage/'web.tar.gz','r:gz') as archive:
    for member in archive.getmembers():
        assert (web/member.name).resolve().is_relative_to(web) and (member.isfile() or member.isdir())
    archive.extractall(web)
for name,digest in manifest['web_files'].items():
    path=(web/name).resolve()
    assert path.is_relative_to(web) and sha(path)==digest
assert b'"/assets/' in (web/'index.html').read_bytes()
inherited=inherit_immutable_assets(previous/'assets',web/'assets')
if (previous/'uploads').is_symlink():
    (web/'uploads').symlink_to((previous/'uploads').resolve(),target_is_directory=True)
(web/'version.json').write_text(json.dumps({**manifest,'api_release':'review137-20261116-r3','schema':114,'purpose':'team review'},indent=2))
(target/'previous-web.txt').write_text(str(previous)+'\n')
(target/'before.json').write_text(json.dumps(before,indent=2))
for root,dirs,files in os.walk(web):
    Path(root).chmod(0o755)
    for name in files:
        path=Path(root)/name
        if not path.is_symlink():path.chmod(0o644)
next_link=link.with_name('dist-root.next-android139')
assert not next_link.exists() and not next_link.is_symlink()
assert snapshot()==before and link.resolve()==previous,'Concurrent change; cutover refused'
next_link.symlink_to(web,target_is_directory=True);os.replace(next_link,link)
try:
    for route in ['/','/profile','/corporate','/devices']:
        assert hashlib.sha256(get(route)).hexdigest()==sha(web/'index.html')
    for name,digest in manifest['web_files'].items():
        if name.endswith(('.js','.css')):assert hashlib.sha256(get('/'+name)).hexdigest()==digest
    assert json.loads(get('/version.json'))['release']==manifest['release']
    assert snapshot()==before,'Protected state changed'
except Exception:
    if link.resolve()==web:
        next_link.symlink_to(previous,target_is_directory=True);os.replace(next_link,link)
    raise
result={'release':manifest['release'],'previous':str(previous),'target':str(web),'protected_state_unchanged':True,'inherited_assets':inherited,'after':snapshot()}
(target/'deployment.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
