"""Pinned99->114 recovery and compressed-write rehearsal, synthetic host only."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import time
import rehearse_runtime125 as prior

JOB=Path('/home/etcom-hub/build/gps-runtime128-20261115')
HOST,NET='gps-runtime128-host','gps-runtime128-private'
API_SHA='5c6f4529207f9ab0d5d30598dbb4fe8a4e4b77dc4e5304a8736f311fdcdb7e52'
base=prior.base
prior.JOB,prior.HOST,prior.NET,prior.API_SHA=JOB,HOST,NET,API_SHA
base.JOB,base.HOST,base.NET,base.OUT=JOB,HOST,NET,JOB/'out'
old_call=base.call


def call(*args,**kw):
    return old_call(*('gps.runtime128=synthetic' if x=='gps.runtime121=synthetic' else x for x in args),**kw)


base.call=call
sha=lambda value:hashlib.sha256(value).hexdigest()


def prepare():
    base.guard();base.OUT.mkdir(exist_ok=True)
    assert not (base.OUT/'host-before.json').exists()
    from build_cleanup_20261113 import protected,containers
    before=dict(protected=protected(),containers=containers(),free_bytes=shutil.disk_usage(JOB).free)
    (base.OUT/'host-before.json').write_text(json.dumps(before,indent=2));assert before['free_bytes']>4*1024**3
    previous=JOB.parent/'gps-runtime127-20261115'
    assert sha((previous/'candidate-runtime127-20261115-r1.tar.gz').read_bytes())=='2d4975611671b93eca2b47dec2fc3824ca7f511a0fa1aa5f95ab76ace02fdf3e'
    for target,source in [('gps-tracker-api','gps-tracker-api127'),('gps-pdf-render','gps-pdf-render'),('gps-tracker-api.baseline99','gps-tracker-api.baseline99')]:
        shutil.copy2(previous/'out'/source,base.OUT/target)
    assert sha((base.OUT/'gps-tracker-api').read_bytes())==API_SHA
    assert sha((base.OUT/'gps-pdf-render').read_bytes())=='f73150c48d4a4507547ae5f63f01f3f7a817e820e87c49492a08948059b662d2'
    assert sha((base.OUT/'gps-tracker-api.baseline99').read_bytes())=='fa1e51e3d39473ca2852ac6b2899790547fa6667bb7337c646d29258a3e1c0fe'
    shutil.copytree(previous/'canonical',JOB/'canonical')
    migration='0114_location_single_scan.sql'
    source=previous/'src/gps-tracker-api/migrations'/migration
    assert sha(source.read_bytes())=='7b8dd29bef39d1724f1bf39e3fda31cd6d276e08b44fd411b5457414320dc08e'
    shutil.copy2(source,JOB/'canonical/gps-tracker-api/migrations'/migration)
    files={p.name:sha(p.read_bytes()) for p in (JOB/'canonical/gps-tracker-api/migrations').glob('*.sql')}
    assert len(files)==114
    (base.OUT/'migration-bytes128.json').write_text(json.dumps(files,indent=2))
    print('PASS128 pinned114/99/PDF inputs and host preservation snapshot',flush=True)


def setup():
    base.setup();base.write('/opt/gps121/candidate124.sha256',API_SHA)
    generated=prior.adapter('runtime121_cumulative.py')
    source=generated.read_text().replace('range(100, 114)','range(100, 115)').replace('113','114').replace('all fourteen','all fifteen')
    source=source.replace('from verify_runtime125_reads import restored','from verify_runtime128 import restored')
    source=source.replace("quiet('docker', 'exec', DB, 'dropdb', '-U', 'postgres', '--force', 'gps_cumulative_restore')",'')
    compile(source,str(generated),'exec');generated.write_text(source)
    base.call('docker','cp',str(generated),HOST+':/opt/gps121/runtime121_cumulative.py')
    for name in ('test_runtime121.py','restore_runtime121.py','validate_runtime121.py'):
        raw=(JOB/'src/ops'/name).read_text();updated=raw.replace('112','114')
        compile(updated,name,'exec');base.write('/opt/gps121/'+name,updated)
        (base.OUT/'adapters'/name).write_text(updated)
    (base.OUT/'adapters/cumulative128.json').write_text(json.dumps(dict(
        source_sha256=sha((JOB/'src/ops/runtime121_cumulative.py').read_bytes()),
        generated_sha256=sha(generated.read_bytes()),schema_path=[99,114],migration_faults=15),indent=2))
    print('PASS128 native2CPU/4GiB fixture,115 denied, no host port/bind',flush=True)
    install()


def install():
    """Install only128 harness/ops in the labeled fixture; API stays pinned127."""
    info=json.loads(call('docker','inspect',HOST).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime128')=='synthetic'
    old=JOB.parent/'gps-runtime127-20261115/src/ops/location_query_bounds.py'
    assert sha(old.read_bytes())=='8b7bc3a28c80a153b0ba5e0e26957b7c7f25d701bf2bb9c8947a022bb891fea2'
    call('docker','cp',str(old),HOST+':/opt/gps121/before_bounds128.py')
    for name in ('location_query_bounds.py','candidate_bounds128.py'):
        call('docker','cp',str(JOB/'src/ops/location_query_bounds.py'),HOST+':/opt/gps121/'+name)
    stats=(JOB/'src/ops/test_statistics126.py').read_text().replace('VALUES(114,true)','VALUES(115,true)').replace('unreviewed114','unreviewed115')
    stats=stats.replace('v.stop_api()\nresults=[]',"v.stop_api()\nv.transition(dsn,ring,str(v.ROOT/'test-storage/uploads'),str(v.ROOT/'test-storage/private'),'fence')\nresults=[]")
    stats=stats.replace('statistics-guards126','statistics-guards128')
    perf=(JOB/'src/ops/perf_runtime127.py').read_text().replace('127','128')
    perf=perf.replace("out/prototype128.json","out/restored128.json")
    perf=perf.replace("fixture='130000 rows;623000 raw points;283001 deduplicated;one SIM'", "fixture='130007 rows; queried original SIM130000 rows/623000 samples; second SIM7 rows'")
    boundary=(JOB/'src/ops/verify_query127.py').read_text().replace('127','128')
    oracle=JOB.parent/'gps-runtime127-20261115/out/oracle113-functions.json'
    prior_index=json.loads((JOB.parent/'gps-runtime127-20261115/remote-byte-check.json').read_text())
    assert sha(oracle.read_bytes())==prior_index['files'][oracle.name]['sha256']
    call('docker','cp',str(oracle),HOST+':/opt/gps121/out/'+oracle.name)
    for name,source in [('test_statistics128.py',stats),('perf_after_backfill128.py',perf),('verify_query128.py',boundary)]:
        compile(source,name,'exec');base.write('/opt/gps121/'+name,source)
        (base.OUT/'adapters'/name).write_text(source)
    (base.OUT/'backfill-inputs128.json').write_text(json.dumps(dict(before_sha256=sha(old.read_bytes()),
        candidate_sha256=sha((JOB/'src/ops/location_query_bounds.py').read_bytes()),
        api_sha256=API_SHA),indent=2))
    # The reused125 generator hashes its intermediate113 adapter. Replace that
    # index with the final114 bytes, after all128 adaptations above are applied.
    origins={'test_statistics128.py':'test_statistics126.py',
             'perf_after_backfill128.py':'perf_runtime127.py','verify_query128.py':'verify_query127.py'}
    hashes={}
    for path in (base.OUT/'adapters').glob('*.py'):
        source=JOB/'src/ops'/origins.get(path.name,path.name)
        hashes[path.name]=dict(source_sha256=sha(source.read_bytes()),generated_sha256=sha(path.read_bytes()))
    (base.OUT/'adapters/hashes.json').write_text(json.dumps(hashes,indent=2))


def pdf():
    base.write('/etc/runtime120-test-only','synthetic')
    suite('test_runtime120_service.py')
    (base.OUT/'pdf-lifetime128.json').write_text(base.inside('cat','/tmp/runtime120-service-results.json').stdout)


def reboot():
    import importlib.util
    path=base.OUT/'adapters/validate_runtime121.py'
    spec=importlib.util.spec_from_file_location('validate128',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    for n in (1,2):
        module.reboot()
        shutil.copy2(base.OUT/'reboot121.json',base.OUT/f'reboot128-{n}.json')
        shutil.copy2(base.OUT/'reboot-order121.log',base.OUT/f'reboot-order128-{n}.log')


def suite(name):
    info=json.loads(call('docker','inspect',HOST).stdout)[0];assert info['Config']['Labels'].get('gps.runtime128')=='synthetic'
    began=time.time();stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime(began))
    result=base.inside('python3','/opt/gps121/'+name,check=False,timeout=2400)
    log=base.OUT/(stamp+'-'+name.replace('.py','.log'));log.write_text(result.stdout+result.stderr)
    call('docker','cp',HOST+':/opt/gps121/out/.',str(base.OUT))
    with (base.OUT/'commands.jsonl').open('a') as f:
        f.write(json.dumps(dict(started_utc=stamp,seconds=round(time.time()-began,3),command=name,
            exit=result.returncode,log=log.name,free_bytes=shutil.disk_usage(JOB).free))+'\n')
    print(result.stdout[-4000:]+result.stderr[-2500:],flush=True);assert result.returncode==0,name


def cleanup():
    info=json.loads(call('docker','inspect',HOST).stdout)[0];net=json.loads(call('docker','network','inspect',NET).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime128')=='synthetic'
    assert net['Internal'] and net['Labels'].get('gps.runtime128')=='synthetic'
    assert {v['Name'] for v in net['Containers'].values()}<={HOST}
    call('docker','rm','-f',HOST);call('docker','network','rm',NET)
    from build_cleanup_20261113 import protected,containers
    before=json.loads((base.OUT/'host-before.json').read_text());after=protected()
    assert all(after.get(k)==v for k,v in before['protected'].items())
    assert containers()==before['containers']
    (base.OUT/'host-after.json').write_text(json.dumps(dict(preserved_files=len(before['protected']),
        unchanged_containers=len(before['containers']),free_bytes=shutil.disk_usage(JOB).free,
        synthetic_resources_removed=True,finished_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())),indent=2))
    print('PASS128 synthetic DB/keys removed; old artifacts and other containers preserved',flush=True)


if __name__=='__main__':
    base.guard();action=sys.argv[1]
    if action in ('prepare','setup','install','pdf','reboot','cleanup'):globals()[action]()
    else:suite(action)
