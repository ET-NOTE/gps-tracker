"""Read the test hierarchy; inject one bounded PDF-only OOM and verify recovery."""
import json
from pathlib import Path
import time
import urllib.request
import rehearse_runtime120 as r
from verify_runtime120 import guard


def snapshot():
    values={}
    units=['gps-workload.slice','gps-workload-pdf.slice','gps120-api@one.service','gps120-api@two.service']
    for unit in units:
        cg=r.inside('systemctl','show',unit,'-p','ControlGroup','--value').stdout.strip()
        values[unit]={}
        for key in ('memory.max','memory.peak','memory.current','memory.events','memory.swap.max','memory.swap.current'):
            p=r.inside('cat','/sys/fs/cgroup'+cg+'/'+key,check=False)
            if p.returncode==0:values[unit][key]=p.stdout.strip()
    cg=r.call('systemctl','show',r.PARENT,'-p','ControlGroup','--value').stdout.strip()
    values['host_total']={k:Path('/sys/fs/cgroup'+cg,k).read_text().strip()
        for k in ('memory.max','memory.peak','memory.current','memory.events','memory.swap.max','memory.swap.current')}
    return values


def health():
    ip=r.inspect('container',r.HOST)['NetworkSettings']['Networks'][r.NET]['IPAddress']
    return [json.load(urllib.request.urlopen(f'http://{ip}:{port}/gps-tracker/health',timeout=3)) for port in (3043,3044)]


def run():
    guard();before=snapshot();healthy=health();assert all(x['db'] for x in healthy)
    for u in before.values():assert u['memory.swap.max']=='0' and u['memory.swap.current']=='0'
    assert before['gps-workload-pdf.slice']['memory.max']==str(896*1024**2)
    assert before['host_total']['memory.max']==str(4096*1024**2)
    assert all('oom_kill 0' in v['memory.events'] for v in before.values()),before
    api_pid_before=[r.inside('systemctl','show','gps120-api@'+i,'-p','MainPID','--value').stdout.strip() for i in ('one','two')]
    # The throw-away process has no private limit: its aggregate parent must
    # enforce the cap. No real PDF request or other project is running here.
    r.inside('systemd-run','--unit=gps120-memory-fault','--slice=gps-workload-pdf.slice',
        '-p','MemoryMax=infinity','-p','MemorySwapMax=0','-p','LimitCORE=0',
        '/usr/bin/python3','-c','import time; data=bytearray(2*1024**3); time.sleep(20)')
    until=time.monotonic()+25
    while time.monotonic()<until:
        state=r.inside('systemctl','show','gps120-memory-fault','-p','ActiveState','--value').stdout.strip()
        if state in ('failed','inactive'):break
        assert all(h['db'] for h in health());time.sleep(.2)
    else:raise RuntimeError('fault did not finish')
    result=r.inside('systemctl','show','gps120-memory-fault','-p','Result','--value').stdout.strip()
    assert result=='oom-kill',result
    after=snapshot();assert 'oom_kill 1' in after['gps-workload-pdf.slice']['memory.events'],after
    api_pid_after=[r.inside('systemctl','show','gps120-api@'+i,'-p','MainPID','--value').stdout.strip() for i in ('one','two')]
    assert api_pid_before==api_pid_after
    # Render exact pixels again through the protected socket after the fault.
    code="import sys; sys.path.insert(0,'/opt'); import test_runtime120_service as t; print(t.page())"
    recovery=r.inside('python3','-c',code).stdout.strip();assert recovery=='(1414, 707)',recovery
    r.inside('systemctl','reset-failed','gps120-memory-fault.service')
    report=dict(production_changed=False,profile='isolated 4GiB total; not capacity approval for shared 3GiB VPS',
                before=before,injected_fault_result=result,after=after,api_restarted=False,health=health(),pdf_recovery=recovery)
    (r.OUT/'resources.json').write_text(json.dumps(report,indent=2));print('PASS aggregate PDF OOM is bounded; both APIs and PDF recover',flush=True)


if __name__=='__main__':run()
