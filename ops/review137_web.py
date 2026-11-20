"""Install the root-domain web build; keep API/schema unchanged.

The original runtime136 archive uses a legacy Vite base and is not a root
deployment artifact. This rebuild changes VITE_BASE only, not application code.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import time
import urllib.request

STAGE = Path('/home/mmm/gps-artifacts/review137-20261116-r1')
WEB = Path('/home/mmm/gps-tracker-web/dist-root')
DEST = Path('/home/mmm/releases/review137-20261116-r2/web')
ARCHIVE_SHA = '9a851063d61d72601404a25fa373d9ed028063b901b465335037bb13f14cfeeb'


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


assert os.geteuid() == 0
assert sha(STAGE / 'web-root.tar.gz') == ARCHIVE_SHA
manifest = json.loads((STAGE / 'web-root-manifest.json').read_text())
assert manifest['sha256'] == ARCHIVE_SHA and manifest['vite_base'] == '/'
assert str(WEB.resolve()) == '/home/mmm/releases/privacy-facts-20261106-r1/web'
assert not DEST.exists()
DEST.mkdir(parents=True)
with tarfile.open(STAGE / 'web-root.tar.gz') as archive:
    for member in archive.getmembers():
        p = (DEST / member.name).resolve()
        assert p.is_relative_to(DEST) and member.isfile()
        p.parent.mkdir(parents=True, exist_ok=True)
        with archive.extractfile(member) as source, p.open('wb') as target:
            shutil.copyfileobj(source, target)
for name, digest in manifest['files'].items():
    assert sha(DEST / name) == digest
index = (DEST / 'index.html').read_text()
assert '/gps-tracker/app/' not in index
refs = re.findall(r'(?:src|href)="(/[^\"]+)"', index)
assert refs == manifest['entry_refs']
for ref in refs:
    assert (DEST / ref.lstrip('/')).is_file()
old = WEB.resolve()
for asset in (old / 'assets').iterdir():
    if asset.is_file() and not (DEST / 'assets' / asset.name).exists():
        shutil.copy2(asset, DEST / 'assets' / asset.name)
if (old / 'uploads').is_symlink():
    (DEST / 'uploads').symlink_to((old / 'uploads').resolve(), target_is_directory=True)
(DEST / 'version.json').write_text(json.dumps({'release': 'review137-20261116-r2',
    'api_release': 'runtime136-20261116-r1', 'schema': 114, 'purpose': 'team review', 'vite_base': '/'}))
for p in [DEST.parent, DEST, *DEST.rglob('*')]:
    if not p.is_symlink():
        p.chmod(0o755 if p.is_dir() else 0o644)
temporary = WEB.with_name('dist-root.review137-r2')
assert not temporary.exists() and not temporary.is_symlink()
temporary.symlink_to(DEST)
os.replace(temporary, WEB)
try:
    for ref in ['/profile', *refs]:
        with urllib.request.urlopen('https://gps.serial.kr' + ref, timeout=15) as response:
            content = response.read()
            name = 'index.html' if ref == '/profile' else ref.lstrip('/')
            assert hashlib.sha256(content).hexdigest() == manifest['files'][name], ref
            if ref.endswith('.js'):
                assert 'javascript' in response.headers.get('Content-Type', ''), ref
except Exception:
    temporary.symlink_to(old)
    os.replace(temporary, WEB)
    raise
result = {'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'passed': True,
          'web': str(DEST), 'archive_sha256': ARCHIVE_SHA, 'vite_base': '/',
          'entry_files_and_mime_verified': len(refs) + 1, 'api_restarted': False,
          'previous_web': str(old), 'browser_followup_required': True}
(STAGE / 'web-root-deployment.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
