"""Fail-closed startup checks inside the service's own mount/cgroup namespace.

Input is root-owned configuration, not a self-issued compliance certificate.
Mount absence must also fail closed during runtime: systemd BindsTo plus root
owned underlying directories and a fallback symlink are part of the profile.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def protected_file(path):
    path = Path(path)
    require(not path.is_symlink(), 'protected file is a symlink')
    for p in [path, *path.parents]:
        s = p.stat()
        require(s.st_uid == 0 and not s.st_mode & (stat.S_IWGRP | stat.S_IWOTH),
                'protected path must be root-owned and not writable by group/others')
    return path


def verify(plan_path):
    plan = json.loads(protected_file(plan_path).read_text())
    library = protected_file(plan['library'])
    require(hashlib.sha256(library.read_bytes()).hexdigest() == plan['library_sha256'],
            'memory-protection library hash mismatch')
    require(os.environ.get('LD_PRELOAD') == str(library), 'memory-protection library not selected')
    import ctypes
    require(ctypes.CDLL(None).prctl(3, 0, 0, 0, 0) == 0, 'process is dumpable')
    mounts = [line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines()]
    checked = []
    for spec in plan['mounts']:
        # systemd ReadWritePaths may stack bind mounts at the same path. Inspect
        # the mount actually opened by this process, not an obscured lower mount.
        fd = os.open(spec['path'], os.O_PATH | os.O_DIRECTORY)
        try:
            mount_id = next(line.split()[1] for line in Path(f'/proc/self/fdinfo/{fd}').read_text().splitlines()
                            if line.startswith('mnt_id:'))
        finally:
            os.close(fd)
        matches = [m for m in mounts if m[0] == mount_id and m[4] == spec['path']]
        require(len(matches) == 1, 'protected temporary mount missing')
        m = matches[0]
        filesystem = m[m.index('-') + 1]
        options = set(m[5].split(','))
        require(filesystem == 'tmpfs' and {'rw', 'nosuid', 'nodev', 'noexec'} <= options,
                'temporary mount has unsafe type/options')
        capacity = os.statvfs(spec['path']).f_blocks * os.statvfs(spec['path']).f_frsize
        require(0 < capacity <= spec['max_bytes'], 'temporary mount exceeds budget')
        checked.append({'path': spec['path'], 'capacity': capacity, 'type': filesystem, 'mount_id': mount_id})
    fallback = Path(plan['fallback_link'])
    require(fallback.is_symlink() and os.readlink(fallback) == plan['fallback_target'],
            'database fallback is not directed to protected storage')
    group = next(line[3:] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
    cg = Path('/sys/fs/cgroup') / group.lstrip('/')
    require((cg / 'memory.swap.max').read_text().strip() == '0', 'service swap is not disabled')
    require((cg / 'memory.swap.current').read_text().strip() == '0', 'service has existing swapped pages')
    require((cg / 'memory.max').read_text().strip() == str(plan['memory_max_bytes']),
            'service memory budget differs from reviewed plan')
    return {'passed': True, 'mounts': checked, 'dumpable': 0, 'swap_max': 0,
            'memory_max': plan['memory_max_bytes']}


if __name__ == '__main__':
    try:
        print(json.dumps(verify(sys.argv[1])))
    except Exception as error:
        print('GPS runtime startup refused: ' + str(error), file=sys.stderr)
        sys.exit(78)
