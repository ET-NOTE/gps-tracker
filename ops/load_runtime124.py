"""Round124: same seeded workload with separate HTTP/retry wait diagnostics."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import sys
import load_runtime122 as load

ROOT = load.ROOT
PREVIOUS = '1052de1ee68e700b6565e73124e727ef45ee26527c7eb9f196c71efcdd0221f5'


original_secret = load.secret
def secret(path, value):
    if str(path)=='/etc/gps121/api.env':
        value+='\nRUST_LOG=info,gps_read_timing=debug'
    original_secret(path,value)
load.secret = secret


def timings(label):
    invocation=load.command('systemctl','show','gps121-api','-p','InvocationID','--value')
    lines=load.command('journalctl','_SYSTEMD_INVOCATION_ID='+invocation,'-o','cat','--no-pager').splitlines()
    rows=[]
    for line in lines:
        if 'location read phases' not in line:continue
        line=re.sub(r'\x1b\[[0-9;]*m','',line)
        row={}
        for key in ('class','outcome','last_phase'):
            row[key]=re.search(r'\b'+key+r'="([a-z]+)"',line)[1]
        assert row['class'] in ('regular','history')
        assert row['outcome'] in ('completed','unfinished','busy')
        assert row['last_phase'] in ('admission','pool','setup','scope')
        for key in ('admission_ms','pool_ms','setup_ms','scope_ms'):
            row[key]=float(re.search(r'\b'+key+r'=([0-9.eE+-]+)',line)[1])
            assert row[key]>=0
        rows.append(row)
    assert rows, 'Opt-in API timing records missing'
    load.save('timings124-'+label,dict(rows=rows,allowlisted_numeric_fields_only=True,
        scope_note='Transaction-held scope, not pure SQL; excludes background cancel cleanup'))


def select(previous=False):
    load.stop_api()
    name = 'gps-tracker-api.previous' if previous else 'gps-tracker-api'
    target = ROOT/'out'/name
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    assert digest == (PREVIOUS if previous else (ROOT/'candidate124.sha256').read_text().strip())
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
    assert r.status==200 and health['release']==('runtime123-20261113-r1' if previous else 'runtime124-20261114-r1')
    assert link.resolve()==target and hashlib.sha256(target.read_bytes()).hexdigest()==digest
    load.save('executable124-'+('previous' if previous else 'candidate'),dict(pid=int(pid),health=health,
        root_owned_sha256=digest,mode=oct(target.stat().st_mode & 0o777),startup_link=str(target),
        proc_exe_hash_unavailable_due_to_dump_protection=True))


if __name__ == '__main__':
    action = sys.argv[1]
    load.b.SHA = (ROOT/'candidate124.sha256').read_text().strip()
    if action == 'seed': load.seed()
    elif action in ('baseline-1','baseline-2','candidate-1','candidate-2','shared-before','shared-after'):
        select(action.startswith('baseline') or action=='shared-before')
        try:
            if action.startswith('shared'): load.shared(True)
            load.load(action+'-124',300)
            if not (action.startswith('baseline') or action=='shared-before'):timings(action)
        finally:
            if action.startswith('shared'): load.shared(False)
    elif action == 'candidate': select()
    else: raise ValueError(action)
