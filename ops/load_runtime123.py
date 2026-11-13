"""Round123: reuse exact122 workload, compare old/new admission, longer runs."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import sys
import load_runtime122 as load

ROOT = load.ROOT
PREVIOUS = '56912e102bd55db65f253d7f19c409a04e239b8e993f60baead577e51efbf536'


def select(previous=False):
    load.stop_api()
    name = 'gps-tracker-api.previous' if previous else 'gps-tracker-api'
    target = ROOT/'out'/name
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    assert digest == (PREVIOUS if previous else (ROOT/'candidate123.sha256').read_text().strip())
    os.chown(target,0,0); target.chmod(0o555)
    link = Path('/opt/gps-tracker-api')
    assert link.is_symlink() and link.resolve().parent == ROOT/'out'
    link.unlink(); link.symlink_to(target)
    load.b.SHA = digest
    load.start(300)
    pid = load.command('systemctl','show','gps121-api','-p','MainPID','--value')
    # dumpable=0 deliberately denies /proc/PID/exe even to container root
    # without ptrace capability. Keep that protection; attest root-owned bytes,
    # exact startup link and the release identifier returned by the live API.
    c=http.client.HTTPConnection('127.0.0.1',3043,timeout=5)
    c.request('GET','/gps-tracker/health');r=c.getresponse();health=json.loads(r.read());c.close()
    assert r.status==200 and health['release']==('runtime120-20261113-r1' if previous else 'runtime123-20261113-r1')
    assert link.resolve()==target and hashlib.sha256(target.read_bytes()).hexdigest()==digest
    load.save('executable123-'+('previous' if previous else 'candidate'),dict(pid=int(pid),health=health,
        root_owned_sha256=digest,mode=oct(target.stat().st_mode & 0o777),startup_link=str(target),
        proc_exe_hash_unavailable_due_to_dump_protection=True))


if __name__ == '__main__':
    action = sys.argv[1]
    load.b.SHA = (ROOT/'candidate123.sha256').read_text().strip()
    if action == 'seed': load.seed()
    elif action in ('baseline','screen','dedicated','shared'):
        select(action == 'baseline')
        try:
            if action == 'shared': load.shared(True)
            load.load('baseline-4g' if action == 'baseline' else action+'-123',300 if action in ('baseline','screen') else 900)
        finally:
            if action == 'shared': load.shared(False)
    elif action == 'candidate': select()
    else: raise ValueError(action)
