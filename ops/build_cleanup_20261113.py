"""One-shot GPS build-cache cleanup. Default: inspect; apply requires that plan.

Only compiler targets and installed web dependencies are disposable here.
Release/source archives, binaries, firmware, database backups and other projects
are never deletion candidates. No timer or automatic artifact rotation is added.
Run on etcom-hub: python3 build_cleanup_20261113.py plan|apply EVIDENCE_DIRECTORY
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path('/home/etcom-hub/build')
CACHE = ROOT / 'gps-tracker/cache'
REQUIRED = {
    'gps-runtime120-20261113/candidate-runtime120-20261113-r1.tar.gz':
        '3b4bfa22719081d7a6f11448f23cb86f6cbfad4c0175aaea78dc5346e426bd33',
    'gps-runtime119-20261112/candidate-runtime119-20261112-r1.tar.gz':
        '902a2002aeb12befd0a8c385f074d5dff1b911b698c493e071035072a4c198de',
    'gps-provision22-20261111cumulative116/candidate-cumulative116-20261111-r1.tar.gz':
        'b0ad2eb25f993df683ccbcda76f0d0533e469132eca22798c23bc766a14c128f',
    'gps-runtime120-20261113/out/gps-tracker-api':
        '56912e102bd55db65f253d7f19c409a04e239b8e993f60baead577e51efbf536',
    'gps-runtime120-20261113/out/gps-pdf-render':
        'f73150c48d4a4507547ae5f63f01f3f7a817e820e87c49492a08948059b662d2',
}


def require(value, message):
    if not value:
        raise RuntimeError(message)


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def size(path):
    return int(run('du', '-sx', '-B1', str(path)).split()[0])


def write(directory, name, data):
    (directory / name).write_text(json.dumps(data, indent=2) + '\n')


def disposable(path):
    relative = path.relative_to(ROOT)
    require(path.resolve() == path and not path.is_symlink(), 'Unexpected link: ' + str(path))
    require(relative.parts[0].startswith('gps-'), 'Outside GPS build area')
    require(not any('shield' in part or part == 'venv' for part in relative.parts), 'Protected tree')
    allowed = path in (CACHE / 'target', CACHE / 'target-pdf') or (
        path.name == 'node_modules' and len(relative.parts) <= 6
        and (path.parent / 'package-lock.json').is_file()
        and (path.parent / 'package.json').is_file())
    require(allowed, 'Not a reproducible cache: ' + str(path))
    require(path.stat().st_dev == ROOT.stat().st_dev, 'Different filesystem')


def candidates():
    result = [p for p in (CACHE / 'target', CACHE / 'target-pdf') if p.is_dir()]
    for top in ROOT.glob('gps-*'):
        if not top.is_dir() or top.is_symlink() or 'shield' in top.name:
            continue
        for directory, dirs, _ in os.walk(top, followlinks=False):
            parent = Path(directory)
            dirs[:] = [d for d in dirs if not (parent / d).is_symlink()
                       and d not in ('venv', '.git', 'cache') and 'shield' not in d]
            if 'node_modules' in dirs:
                path = parent / 'node_modules'
                disposable(path)
                result.append(path)
                dirs.remove('node_modules')
            if len(parent.relative_to(ROOT).parts) >= 5:
                dirs.clear()
    records = []
    for path in sorted(result):
        disposable(path)
        records.append(dict(path=str(path.relative_to(ROOT)), bytes=size(path),
                            inode=path.stat().st_ino, device=path.stat().st_dev))
    return records


def containers():
    ids = run('docker', 'ps', '-q').splitlines()
    result = []
    for obj in json.loads(run('docker', 'inspect', *ids)) if ids else []:
        mounts = [item['Source'] for item in obj.get('Mounts', [])]
        require(not any(str(ROOT / 'gps-') in p for p in mounts), 'GPS build container still mounted')
        result.append(dict(id=obj['Id'], name=obj['Name'], started=obj['State']['StartedAt'],
                           restarts=obj['RestartCount']))
    return sorted(result, key=lambda item: item['name'])


def idle():
    for proc in Path('/proc').glob('[0-9]*'):
        if proc.name == str(os.getpid()):
            continue
        try:
            cmd = (proc / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
            cwd = os.readlink(proc / 'cwd')
            comm = (proc / 'comm').read_text().strip()
        except (OSError, PermissionError):
            continue
        require(str(ROOT / 'gps-') not in cmd and not cwd.startswith(str(ROOT / 'gps-'))
                and comm not in ('cargo', 'rustc'), 'Build process still active: PID ' + proc.name)
    return containers()


def protected():
    # Hash retained deployment binaries and archives, not credentials or DB contents.
    result = {}
    for top in ROOT.glob('gps-*'):
        if not top.is_dir() or top.is_symlink() or 'shield' in top.name:
            continue
        for directory, dirs, files in os.walk(top, followlinks=False):
            parent = Path(directory)
            dirs[:] = [d for d in dirs if not (parent / d).is_symlink() and
                       d not in ('cache', 'node_modules', 'venv', '.git', 'target', 'build') and 'shield' not in d]
            for name in files:
                path = parent / name
                if not path.is_symlink() and (name in ('gps-tracker-api', 'gps-pdf-render') or
                                             name.endswith(('.tar.gz', '.tgz', '.zip', '.bin', '.elf'))):
                    result[str(path.relative_to(ROOT))] = dict(bytes=path.stat().st_size, sha256=sha(path))
    for name, digest in REQUIRED.items():
        require(result.get(name, {}).get('sha256') == digest, 'Required candidate mismatch: ' + name)
    return result


def main():
    mode, output = sys.argv[1:]
    require(mode in ('plan', 'apply'), 'Use plan or apply')
    require(run('hostname') == 'etcom-hub' and ROOT.resolve() == ROOT, 'Wrong host/root')
    output = Path(output).resolve()
    require(output == Path('/home/etcom-hub/gps-cleanup-20261113'), 'Unexpected evidence directory')
    output.mkdir(exist_ok=True)
    locks = [(ROOT / 'gps-tracker/build.lock').open('a'), (CACHE / 'build.lock').open('a')]
    for lock in locks:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    services = idle()
    items = candidates()
    before = protected()
    current = dict(at=datetime.now(timezone.utc).isoformat(), candidates=items,
                   protected=before, containers=services, disk_free=shutil.disk_usage(ROOT).free)
    if mode == 'plan':
        require(not (output / 'applied.json').exists(), 'Cleanup already applied')
        write(output, 'plan.json', current)
        print(json.dumps(dict(mode=mode, items=len(items), reclaim_gib=sum(x['bytes'] for x in items)/1024**3,
                              protected_files=len(before), disk_free_gib=current['disk_free']/1024**3)), flush=True)
        return
    plan = json.loads((output / 'plan.json').read_text())
    require(items == plan['candidates'] and before == plan['protected'], 'Inventory changed since plan')
    require(services == plan['containers'], 'Running services changed since plan')
    idle()
    removed = []
    for item in items:
        path = ROOT / item['path']
        disposable(path)
        require(path.stat().st_ino == item['inode'] and path.stat().st_dev == item['device'], 'Path replaced')
        for row in Path('/proc/self/mountinfo').read_text().splitlines():
            mount = row.split()[4]
            require(mount != str(path) and not mount.startswith(str(path) + '/'), 'Mounted cache subtree')
        shutil.rmtree(path)
        removed.append(item)
        write(output, 'removed.json', removed)
        print('Removed reproducible cache: ' + item['path'], flush=True)
    after = protected()
    require(after == before, 'Retained artifact changed')
    require(containers() == services, 'Running services changed')
    result = dict(at=datetime.now(timezone.utc).isoformat(), removed=removed, protected_files=len(after),
                  protected_hashes_unchanged=True, containers_unchanged=True,
                  disk_free_before=current['disk_free'], disk_free_after=shutil.disk_usage(ROOT).free,
                  automatic_rotation=False, production_accessed=False)
    write(output, 'applied.json', result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
