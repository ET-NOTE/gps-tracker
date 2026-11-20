"""Fixed119 fail-closed startup and actual runtime-process checks; synthetic only."""
import json
from pathlib import Path
import subprocess
import time
import urllib.request

JOB=Path('/home/etcom-hub/build/gps-provision22-20261112cumulative119')
DB='gps-provision22-db-20261112cumulative119'
API='gps-provision22-api-20261112cumulative119'
NET='gps-provision22-test-20261112cumulative119'
report={'production_modified':False,'checks':[]}


def record(name, passed, **details):
    report['checks'].append(dict(name=name,passed=passed,**details))
    (JOB/'out/process119.json').write_text(json.dumps(report,indent=2))
    print(name,passed,flush=True); assert passed,name


base=['/usr/bin/docker','run','--rm','--network','none','--memory=550m','--ulimit=core=0',
      '--user','1000:1000','--cap-drop=ALL','--security-opt=no-new-privileges']
mount=['--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m']
for name,extra in [('missing temporary mount',['--memory-swap=550m']),
                   ('swap budget enabled',['--memory-swap=600m',*mount]),
                   ('missing memory library',['--memory-swap=550m',*mount,'-e','LD_PRELOAD=']),
                   ('oversize temporary mount',['--memory-swap=550m','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=65m']),
                   ('executable temporary mount',['--memory-swap=550m','--tmpfs','/tmp:rw,nosuid,nodev,exec,size=64m'])]:
    p=subprocess.run([*base,*extra,'gps-runtime119:20261112','python3','-c',"print('PAYLOAD_EXECUTED')"],capture_output=True,text=True)
    record('before-key guard rejects '+name,p.returncode==78 and 'PAYLOAD_EXECUTED' not in p.stdout,error=p.stderr.strip())

for name in (DB,API):
    info=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
    assert info['Config']['Labels']['gps.runtime119']=='synthetic' and not info['HostConfig']['PortBindings']
    values={k:subprocess.check_output(['docker','exec',name,'cat','/sys/fs/cgroup/'+k],text=True).strip()
            for k in ('memory.max','memory.swap.max','memory.swap.current','memory.events')}
    probe=subprocess.check_output(['docker','exec',name,'python3','-c','import ctypes; print(ctypes.CDLL(None).prctl(3,0,0,0,0))'],text=True).strip()
    record(name+' protected process',probe=='0' and values['memory.swap.max']=='0' and values['memory.swap.current']=='0',cgroup=values,exec_probe_dumpable=int(probe))

p=subprocess.run(['docker','exec','-e','LD_PRELOAD=',API,'env','-i','/gps-pdf-render','selftest'],capture_output=True,text=True)
value=json.loads(p.stdout)
record('actual static PDF renderer with empty environment',p.returncode==0 and value['sandbox_holds'] and value['enable_dumping']['blocked'],selftest=value)
subprocess.run(['docker','restart',API],check=True,stdout=subprocess.DEVNULL)
host=json.loads(subprocess.check_output(['docker','inspect',API]))[0]['NetworkSettings']['Networks'][NET]['IPAddress']
for _ in range(60):
    try:
        with urllib.request.urlopen('http://'+host+':3043/gps-tracker/health',timeout=2) as response:
            if json.load(response)['db']: break
    except Exception: pass
    time.sleep(.5)
else: raise AssertionError('restart failed')
record('actual API restart repeats guard and returns healthy',True)
