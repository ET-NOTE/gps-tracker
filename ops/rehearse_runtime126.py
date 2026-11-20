"""Round126 restore performance fixture. Synthetic build host only, no deployment."""
import json
from pathlib import Path
import shutil
import sys
import time
import rehearse_runtime125 as prior

JOB=Path('/home/etcom-hub/build/gps-runtime126-20261115')
HOST,NET='gps-runtime126-host','gps-runtime126-private'
base=prior.base
prior.JOB,prior.HOST,prior.NET=JOB,HOST,NET
base.JOB,base.HOST,base.NET,base.OUT=JOB,HOST,NET,JOB/'out'
call125=prior.call


def call(*args,**kw):
    args=tuple('gps.runtime126=synthetic' if x=='gps.runtime121=synthetic' else x for x in args)
    return call125(*args,**kw)


base.call=call


def prepare():
    base.guard();base.OUT.mkdir(exist_ok=True)
    assert not (base.OUT/'host-before.json').exists()
    from build_cleanup_20261113 import protected,containers
    before=dict(protected=protected(),containers=containers(),free_bytes=shutil.disk_usage(JOB).free)
    (base.OUT/'host-before.json').write_text(json.dumps(before,indent=2))
    assert before['free_bytes']>4*1024**3
    root=JOB.parent/'gps-runtime125-20261114'
    assert prior.sha((root/'recovery-kit-runtime125-20261114-r1.tar.gz').read_bytes())=='f469828ce877ffffa555fe9b168200c7e423c0e1228f9a858df5218f67ec6c73'
    for name in ('gps-tracker-api','gps-pdf-render','gps-tracker-api.baseline99'):
        shutil.copy2(root/'out'/name,base.OUT/name)
    shutil.copytree(root/'canonical',JOB/'canonical')
    prior.finish_prepare()


def setup():
    base.setup()
    generated=prior.adapter('runtime121_cumulative.py')
    source=generated.read_text()
    start=source.index('from verify_runtime125_reads import restored')
    source=source[:start]+'''from verify_runtime126 import prepare_restore
prepare_restore(restore_dsn, runtime.rsplit('/',1)[0]+'/gps_cumulative_restore',uid,did,ring)
record('126 diagnostic fixture ready; restore DB remains fenced, API stopped')
'''
    compile(source,str(generated),'exec');generated.write_text(source)
    (base.OUT/'adapters/runtime126-hash.json').write_text(json.dumps(dict(
        input_sha256=prior.sha((JOB/'src/ops/runtime121_cumulative.py').read_bytes()),
        generated_sha256=prior.sha(generated.read_bytes()),
        scope='125 migration/conversion/full hash restore; stop before clone deletion'),indent=2))
    base.call('docker','cp',str(generated),HOST+':/opt/gps121/runtime121_cumulative.py')
    base.write('/opt/gps121/candidate124.sha256',prior.API_SHA)
    base.inside('mkdir','-p','/opt/gps121/profile-source')
    for name in ('devices.rs','locations.rs'):
        base.call('docker','cp',str(JOB/'src/gps-tracker-api/src/routes'/name),HOST+':/opt/gps121/profile-source/'+name)
    print('PASS126 2CPU/4GiB internal fixture; no host bind/published port',flush=True)


def install(phase):
    """Use pinned125 transition for reproduction, then the reviewed126 fix."""
    assert phase in ('before','candidate')
    root=JOB.parent/'gps-runtime125-20261114/src/ops' if phase=='before' else JOB/'src/ops'
    names=['crypto20b_transition.py'] if phase=='before' else ['crypto20b_transition.py','location_query_statistics.py']
    values={}
    for name in names:
        source=root/name
        values[name]=prior.sha(source.read_bytes())
        # Pin125's actual archived/tested bytes, including its line endings.
        if phase=='before':assert values[name]=='b637f14cccd4d37570c231b4dc4976f7cb8bf32f2f33d65bf261a40dd1fd2feb'
        base.call('docker','cp',str(source),HOST+':/opt/gps121/'+name)
    (base.OUT/('installed-'+phase+'126.json')).write_text(json.dumps(dict(phase=phase,source=str(root),sha256=values),indent=2))


def suite(name):
    info=json.loads(base.call('docker','inspect',HOST).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime126')=='synthetic'
    begin=time.time();stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime(begin))
    p=base.inside('python3','/opt/gps121/'+name,check=False,timeout=1800)
    log=base.OUT/(stamp+'-'+name.replace('.py','.log'));log.write_text(p.stdout+p.stderr)
    base.call('docker','cp',HOST+':/opt/gps121/out/.',str(base.OUT))
    with (base.OUT/'commands.jsonl').open('a') as f:
        f.write(json.dumps(dict(started_utc=stamp,seconds=round(time.time()-begin,3),command=name,
            exit=p.returncode,log=log.name,free_bytes=shutil.disk_usage(JOB).free))+'\n')
    print(p.stdout[-4500:]+p.stderr[-3000:],flush=True)
    assert p.returncode==0,name


def cleanup():
    info=json.loads(base.call('docker','inspect',HOST).stdout)[0]
    net=json.loads(base.call('docker','network','inspect',NET).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime126')=='synthetic'
    assert net['Internal'] and net['Labels'].get('gps.runtime126')=='synthetic'
    assert {v['Name'] for v in net['Containers'].values()}<={HOST}
    base.call('docker','rm','-f',HOST);base.call('docker','network','rm',NET)
    from build_cleanup_20261113 import protected,containers
    before=json.loads((base.OUT/'host-before.json').read_text());after=protected()
    assert all(after.get(k)==v for k,v in before['protected'].items())
    assert containers()==before['containers']
    (base.OUT/'host-after.json').write_text(json.dumps(dict(preserved_files=len(before['protected']),
        unchanged_containers=len(before['containers']),free_bytes=shutil.disk_usage(JOB).free,
        synthetic_resources_removed=True,finished_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())),indent=2))
    print('PASS126 prior artifacts/other containers preserved; synthetic DB/keys removed',flush=True)


if __name__=='__main__':
    base.guard()
    action=sys.argv[1]
    if action in ('prepare','setup','cleanup'):globals()[action]()
    elif action in ('before','candidate'):install(action)
    else:suite(action)
