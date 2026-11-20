"""Pinned114, bounded multi-terminal load on the synthetic build host only."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import time
import rehearse_runtime124 as prior

JOB=Path('/home/etcom-hub/build/gps-runtime130-20261115')
HOST,NET='gps-runtime130-host','gps-runtime130-private'
API_SHA='5c6f4529207f9ab0d5d30598dbb4fe8a4e4b77dc4e5304a8736f311fdcdb7e52'
base=prior.base
prior.JOB,prior.HOST,prior.NET=JOB,HOST,NET
base.JOB,base.HOST,base.NET,base.OUT=JOB,HOST,NET,JOB/'out'
old_call=base.call


def call(*args,**kw):
    return old_call(*('gps.runtime130=synthetic' if x=='gps.runtime121=synthetic' else x for x in args),**kw)


base.call=call
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()


def prepare():
    base.guard();base.OUT.mkdir(exist_ok=True)
    assert not (base.OUT/'host-before.json').exists()
    from build_cleanup_20261113 import protected,containers
    before=dict(protected=protected(),containers=containers(),free_bytes=shutil.disk_usage(JOB).free)
    (base.OUT/'host-before.json').write_text(json.dumps(before,indent=2));assert before['free_bytes']>6*1024**3
    previous=JOB.parent/'gps-runtime129-20261115'
    assert sha(previous/'candidate-runtime129-20261115-r1.tar.gz')=='4b0d40965b60cd9081149ac72bc7eba96f9a7510934a56ff7a9dd2c64cedf6bd'
    for name,digest in [('gps-tracker-api',API_SHA),('gps-pdf-render','f73150c48d4a4507547ae5f63f01f3f7a817e820e87c49492a08948059b662d2'),
                        ('gps-tracker-api.baseline99','fa1e51e3d39473ca2852ac6b2899790547fa6667bb7337c646d29258a3e1c0fe')]:
        assert sha(previous/'out'/name)==digest
        shutil.copy2(previous/'out'/name,base.OUT/name)
    shutil.copytree(previous/'canonical',JOB/'canonical')
    hashes={p.name:sha(p) for p in (JOB/'canonical/gps-tracker-api/migrations').glob('*.sql')}
    assert hashes==json.loads((previous/'out/migration-bytes129.json').read_text()) and len(hashes)==114
    (base.OUT/'migration-bytes130.json').write_text(json.dumps(hashes,indent=2))
    (base.OUT/'criteria130.json').write_text(json.dumps(dict(schema=114,production_modified=False,
        api_sha256=API_SHA,query_workers=8,telemetry_devices=8,hz_per_device=1,target_seconds=300,
        planned_reports_each_run=2400,required=['all planned slots sent once and stored per device/counter',
        'all ingress/health200; query responses only200 or explicit429',
        'no new OOM/swap or plaintext; no stranded reads/transactions/images/files',
        'monthly response equivalence including XLSX cells; full pagination completes',
        'same2CPU/8MiBps/200IOPS and GPS3328MiB budget'],
        measured_not_admitted=['429 ratio and retry latency','real3GiB shared VPS capacity',
        'real other-project and antivirus workload','cold host cache and physical modem/network']),indent=2))
    print('PASS130 immutable114 inputs, retained artifacts and predeclared criteria',flush=True)


def setup():
    base.setup();base.write('/opt/gps121/candidate124.sha256',API_SHA)
    print('PASS130 native2CPU/8MiBps/200IOPS; GPS3328MiB; no swap/published port',flush=True)


def suite(action):
    info=json.loads(call('docker','inspect',HOST).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime130')=='synthetic'
    if action.startswith(('baseline-','candidate-')):
        mib=5632 if 'shared' in action else 3584
        call('docker','update','--memory='+str(mib)+'m','--memory-swap='+str(mib)+'m',HOST)
    began=time.time();stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime(began))
    result=base.inside('python3','/opt/gps121/run_runtime130.py',action,check=False,timeout=1800)
    log=base.OUT/(stamp+'-'+action+'.log');log.write_text(result.stdout+result.stderr)
    call('docker','cp',HOST+':/opt/gps121/out/.',str(base.OUT))
    with (base.OUT/'commands.jsonl').open('a') as f:
        f.write(json.dumps(dict(started_utc=stamp,action=action,seconds=round(time.time()-began,3),
            exit=result.returncode,log=log.name,free_bytes=shutil.disk_usage(JOB).free))+'\n')
    print(result.stdout[-4500:]+result.stderr[-3000:],flush=True);assert result.returncode==0,action


def cleanup():
    info=json.loads(call('docker','inspect',HOST).stdout)[0];net=json.loads(call('docker','network','inspect',NET).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime130')=='synthetic'
    assert net['Internal'] and net['Labels'].get('gps.runtime130')=='synthetic'
    assert {v['Name'] for v in net['Containers'].values()}<={HOST}
    call('docker','rm','-f',HOST);call('docker','network','rm',NET)
    from build_cleanup_20261113 import protected,containers
    before=json.loads((base.OUT/'host-before.json').read_text());after=protected()
    assert all(after.get(k)==v for k,v in before['protected'].items())
    assert containers()==before['containers']
    (base.OUT/'host-after.json').write_text(json.dumps(dict(preserved_files=len(before['protected']),
        unchanged_containers=len(before['containers']),free_bytes=shutil.disk_usage(JOB).free,
        synthetic_resources_removed=True,finished_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())),indent=2))
    print('PASS130 only synthetic resources removed; retained artifacts and other containers unchanged',flush=True)


if __name__=='__main__':
    base.guard();action=sys.argv[1]
    if action in ('prepare','setup','cleanup'):globals()[action]()
    else:suite(action)
