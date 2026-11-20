"""Promote the verified design build to dev only; preserve API, data and secrets."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request

HOME = Path('/home/gps-dev')
WORK = HOME / 'workspace/gps-tracker'
LINK = HOME / 'gps-tracker-web-dev/dist'
STAGE = Path('/home/mmm/gps-artifacts/dev-design-cleanup-20261028')
ARTIFACT = Path('/home/mmm/gps-artifacts/web-design-cleanup-20261027-7e42f90')
DEST = HOME / 'releases/dev-design-cleanup-20261028-7e42f90'
BACKUP = HOME / 'backups/design-cleanup-20261028'
OLD_SOURCE = '19736eeaa2ba376baf5e4fbfd947816f0e285e44'
SOURCE = 'bce96c634bca240aaa239f854216d84a5e000155'
WEB_COMMIT = '7e42f9060ca2b0dba64cf5ee35643cc674742c24'
OLD_BRANCH = 'codex/dev-aligned-20261025'
NEW_BRANCH = 'codex/dev-aligned-20261028'


def out(args):
    return subprocess.check_output([str(a) for a in args], text=True).strip()


def git(*args):
    return out(['sudo', '-u', 'gps-dev', 'git', '-C', WORK, *args])


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def get(path, domain='dev-gps.serial.kr'):
    return urllib.request.urlopen('https://' + domain + path, timeout=20).read()


def protected_state():
    prod = Path('/home/mmm/gps-tracker-web/dist-root').resolve()
    paths = [prod/'index.html', prod/'version.json',
             Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api'),
             Path('/home/mmm/projects/gps-tracker-api/.env'),
             HOME/'projects/gps-tracker-api/bin/gps-tracker-api-dev',
             HOME/'projects/gps-tracker-api/.env.dev',
             Path('/etc/nginx/sites-available/gps.serial.kr'),
             Path('/etc/nginx/sites-available/dev-gps.serial.kr.conf')]
    return dict(prod_web=str(prod), files={str(p): sha(p) for p in paths},
                services={s: out(['systemctl', 'show', s, '-p', 'MainPID', '-p', 'ActiveEnterTimestamp'])
                          for s in ['gps-tracker-api', 'gps-tracker-api-dev']})


def save(name, value):
    (BACKUP/name).write_text(json.dumps(value, indent=2) + '\n')


assert os.geteuid() == 0
assert LINK.is_symlink()
previous = LINK.resolve()
assert previous.is_relative_to(HOME/'releases')
prior = json.loads((previous/'version.json').read_text())
assert prior['git_commit'] == '2126bd46e853a154d4a4dbde5684e23523fe60ca'
assert not git('status', '--porcelain'), 'Dev worktree changed; do not overwrite.'
assert git('rev-parse', 'HEAD') == OLD_SOURCE
assert git('branch', '--show-current') == OLD_BRANCH
manifest = json.loads((ARTIFACT/'manifest.json').read_text())
assert manifest['git_commit'] == WEB_COMMIT
assert sha(ARTIFACT/'web.tar.gz') == manifest['archive_sha256']
prod_version = json.loads(get('/version.json', 'gps.serial.kr'))
assert prod_version['git_commit'] == WEB_COMMIT
assert prod_version['archive_sha256'] == manifest['archive_sha256']
health = json.loads(get('/health'))
assert health['ok'] and health['db'] and health['environment'] == 'development'
assert not DEST.exists() and not BACKUP.exists()
baseline = protected_state()
BACKUP.mkdir(mode=0o700)
save('protected-before.json', baseline)
save('before.json', dict(web=str(previous), source=OLD_SOURCE, branch=OLD_BRANCH, version=prior))
# Existing branch and release remain recoverable. Only a clean fast-forward is allowed.
bundle = BACKUP/'source.bundle'
shutil.copy2(STAGE/'source.bundle', bundle)
subprocess.run(['chown', 'gps-dev:gps-dev', BACKUP, bundle], check=True)
git('bundle', 'verify', bundle)
git('fetch', bundle, 'HEAD')
assert git('rev-parse', 'FETCH_HEAD') == SOURCE
git('merge-base', '--is-ancestor', OLD_SOURCE, SOURCE)
changed = git('diff', '--name-only', OLD_SOURCE, SOURCE).splitlines()
assert all(p.startswith(('gps-tracker-web/', 'docs/operations/', 'ops/')) for p in changed)
assert not git('diff', WEB_COMMIT, SOURCE, '--', 'gps-tracker-web'), 'Source must match web artifact.'
DEST.mkdir(mode=0o755)
web = DEST/'web'
web.mkdir(mode=0o755)
with tarfile.open(ARTIFACT/'web.tar.gz', 'r:gz') as archive:
    for entry in archive.getmembers():
        assert (web/entry.name).resolve().is_relative_to(web)
        assert entry.isfile() or entry.isdir()
    archive.extractall(web)
for name, digest in manifest['web_files'].items():
    path = (web/name).resolve()
    assert path.is_relative_to(web) and sha(path) == digest
for old in (previous/'assets').iterdir():
    if old.is_file() and not (web/'assets'/old.name).exists():
        shutil.copy2(old, web/'assets'/old.name)
if (previous/'uploads').is_symlink():
    (web/'uploads').symlink_to((previous/'uploads').resolve(), target_is_directory=True)
version = dict(manifest, release=DEST.name, target='dev', source_checkout=SOURCE,
               api_git_commit=prior['api_git_commit'], api_release=prior['api_release'],
               api_sha256=prior['api_sha256'])
(web/'version.json').write_text(json.dumps(version, indent=2) + '\n')
(DEST/'previous-web.txt').write_text(str(previous) + '\n')
for root, dirs, files in os.walk(web):
    Path(root).chmod(0o755)
    for name in files:
        p = Path(root)/name
        if not p.is_symlink():
            p.chmod(0o644)
subprocess.run(['chown', '-R', 'gps-dev:gps-dev', DEST], check=True)
next_link = LINK.with_name('dist.design-next')
assert not next_link.exists() and not next_link.is_symlink()
assert LINK.resolve() == previous and not git('status', '--porcelain')
assert git('rev-parse', 'HEAD') == OLD_SOURCE and protected_state() == baseline
source_switched = False
web_switched = False
try:
    git('switch', '-c', NEW_BRANCH)
    source_switched = True
    git('merge', '--ff-only', SOURCE)
    next_link.symlink_to(web, target_is_directory=True)
    os.replace(next_link, LINK)
    web_switched = True
    for route in ['/', '/devices', '/corporate', '/rentcar', '/profile']:
        assert hashlib.sha256(get(route)).hexdigest() == sha(web/'index.html')
    for name, digest in manifest['web_files'].items():
        assert hashlib.sha256(get('/'+name)).hexdigest() == digest, name
    deployed = json.loads(get('/version.json'))
    assert deployed['git_commit'] == WEB_COMMIT and deployed['target'] == 'dev'
    assert json.loads(get('/health')) == health
    assert protected_state() == baseline, 'Protected runtime changed; inspect before continuing.'
    assert git('rev-parse', 'HEAD') == SOURCE and not git('status', '--porcelain')
except Exception:
    if web_switched:
        next_link.symlink_to(previous, target_is_directory=True)
        os.replace(next_link, LINK)
    if source_switched:
        git('switch', OLD_BRANCH)
    raise
result = dict(release=DEST.name, web_commit=WEB_COMMIT, source_checkout=SOURCE,
              source_branch=NEW_BRANCH, files_verified=len(manifest['web_files']),
              production_unchanged=True, api_and_environment_unchanged=True,
              database_writes=False, previous_web=str(previous))
save('deployment.json', result)
(DEST/'deployment.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
