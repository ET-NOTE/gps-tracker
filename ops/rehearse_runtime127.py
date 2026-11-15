"""Round127 synthetic compressed-query fixture; never deploys to production."""
import json
from pathlib import Path
import shutil
import sys
import time
import rehearse_runtime126 as previous

JOB=Path('/home/etcom-hub/build/gps-runtime127-20261115')
HOST,NET='gps-runtime127-host','gps-runtime127-private'
base=previous.base
for module in (previous,previous.prior,base):
    module.JOB,module.HOST,module.NET=JOB,HOST,NET
base.OUT=JOB/'out'
old_call=base.call


def call(*args,**kw):
    return old_call(*('gps.runtime127=synthetic' if x=='gps.runtime121=synthetic' else x for x in args),**kw)


base.call=call


def suite(name):
    info=json.loads(call('docker','inspect',HOST).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime127')=='synthetic'
    started=time.time();stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime(started))
    result=base.inside('python3','/opt/gps121/'+name,check=False,timeout=2400)
    log=base.OUT/(stamp+'-'+name.replace('.py','.log'));log.write_text(result.stdout+result.stderr)
    call('docker','cp',HOST+':/opt/gps121/out/.',str(base.OUT))
    with (base.OUT/'commands.jsonl').open('a') as f:
        f.write(json.dumps(dict(started_utc=stamp,seconds=round(time.time()-started,3),command=name,
            exit=result.returncode,log=log.name,free_bytes=shutil.disk_usage(JOB).free))+'\n')
    print(result.stdout[-4000:]+result.stderr[-2500:],flush=True)
    assert result.returncode==0,name


def cleanup():
    info=json.loads(call('docker','inspect',HOST).stdout)[0]
    net=json.loads(call('docker','network','inspect',NET).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime127')=='synthetic'
    assert net['Internal'] and net['Labels'].get('gps.runtime127')=='synthetic'
    assert {v['Name'] for v in net['Containers'].values()}<={HOST}
    call('docker','rm','-f',HOST);call('docker','network','rm',NET)
    from build_cleanup_20261113 import protected,containers
    before=json.loads((base.OUT/'host-before.json').read_text());after=protected()
    assert all(after.get(k)==v for k,v in before['protected'].items())
    assert containers()==before['containers']
    (base.OUT/'host-after.json').write_text(json.dumps(dict(preserved_files=len(before['protected']),
        unchanged_containers=len(before['containers']),free_bytes=shutil.disk_usage(JOB).free,
        synthetic_resources_removed=True,finished_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())),indent=2))
    print('PASS127 prior artifacts/other containers preserved; fixture DB/keys removed',flush=True)


if __name__=='__main__':
    base.guard()
    action=sys.argv[1]
    if action in ('prepare','setup'):getattr(previous,action)()
    elif action=='cleanup':cleanup()
    else:suite(action)
