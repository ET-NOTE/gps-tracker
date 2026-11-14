"""Preserve actual synthetic125 evidence, never keys, dumps or unit environments."""
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile
from rehearse_runtime125 import JOB, HOST, NET, API_SHA, base, original_call, sha

OUT=base.OUT


def collect():
    base.guard()
    info=json.loads(original_call('docker','inspect',HOST).stdout)[0]
    net=json.loads(original_call('docker','network','inspect',NET).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime125')=='synthetic'
    assert net['Internal'] and not info['HostConfig']['Binds'] and not info['HostConfig']['PortBindings']
    h=info['HostConfig']
    (OUT/'environment125.json').write_text(json.dumps(dict(image=info['Image'],internal=True,
        binds=h['Binds'],ports=h['PortBindings'],memory=h['Memory'],memory_swap=h['MemorySwap'],
        cpu_nano=h['NanoCpus'],cap_add=h['CapAdd'],security_opt=h['SecurityOpt'],
        production_modified=False,activation_ready=False),indent=2))
    original_call('docker','cp',HOST+':/opt/gps121/out/.',str(OUT))
    hashes={}
    for name in ('runtime121_cumulative.py','test_runtime121.py','verify_runtime125_reads.py',
        'runtime121_control.py','runtime121_job.py','privacy_file_cleanup.py','restore_runtime121.py'):
        expected=OUT/'adapters'/name if (OUT/'adapters'/name).exists() else JOB/'src/ops'/name
        actual=base.inside('sha256sum','/opt/gps121/'+name).stdout.split()[0]
        assert actual==sha(expected.read_bytes()),name
        hashes[name]=actual
    (OUT/'running-source125.json').write_text(json.dumps(hashes,indent=2))
    units=OUT/'units';units.mkdir(exist_ok=True)
    for name in ('gps121-db.service','gps121-api.service','gps121-migration.service',
        'gps121-transition.service','gps121-cleanup.service','gps121-closure.service',
        'gps121-recovery.service','gps121-checkpoint.service','gps121-underlay.service',
        'gps121-temp-ready.service','run-gps121-sort.mount','run-gps121-fallback.mount',
        'run-gps121-tmp.mount','gps-workload.slice','gps-workload-pdf.slice','gps122-proxy.service'):
        (units/name).write_text(base.inside('systemctl','cat',name).stdout)
    (OUT/'mounts125.txt').write_text(base.inside('findmnt','-n','-o','TARGET,FSTYPE,OPTIONS','-t','tmpfs').stdout)
    for kind in ('transition','cleanup','closure','recovery','checkpoint'):
        original_call('docker','cp',HOST+':/opt/gps121/job-results/'+kind+'-protection.json',str(OUT/(kind+'-protection.json')))
    final=json.loads((OUT/'final-state125.json').read_text())
    assert final['schema']==113 and final['restored_and_rebooted_responses_equal']
    print('PASS125 environment, actual units, source hashes and final state collected',flush=True)


def package(commit):
    base.guard();assert re.fullmatch('[0-9a-f]{40}',commit)
    prior=JOB.parent/'gps-runtime124-20261114/candidate-runtime124-20261114-r1.tar.gz'
    digest='353c16488c7f4aa0fb6cbc264ab0a30f9330ec0fe875ae59208c8be9ec195649'
    assert sha(prior.read_bytes())==digest
    with tarfile.open(JOB/'source.tar') as source:
        files={m.name:hashlib.sha256(source.extractfile(m).read()).hexdigest() for m in source if m.isfile()}
    assert all(sha((JOB/'src'/name).read_bytes())==value for name,value in files.items())
    manifest=dict(release='recovery125-20261114-r1',source_commit=commit,schema=113,
        activation_ready=False,production_installer=False,base_candidate=str(prior),base_sha256=digest,
        api_sha256=API_SHA,source_archive_sha256=sha((JOB/'source.tar').read_bytes()),contents=files,
        boundaries=['Synthetic native99to113 recovery only, no production connection or deployment',
            '2CPU/4GiB DB128MB; not shared3GiB performance admission or production disk timing',
            'Test self-signed localhostTLS1.2; no device or public certificate claim',
            'Runtime least privilege; controlled root transition and postgres recovery',
            'External key/backup/checkpoint custody and old WAL destruction not tested'])
    path=JOB/'manifest125.json';path.write_text(json.dumps(manifest,indent=2))
    archive=JOB/'recovery-kit-runtime125-20261114-r1.tar.gz'
    assert not archive.exists()
    with tarfile.open(archive,'w:gz') as t:
        t.add(path,arcname='runtime125/manifest.json')
        t.add(JOB/'source.tar',arcname='runtime125/source.tar')
        t.add(OUT/'adapters',arcname='runtime125/adapters')
    with tarfile.open(archive) as t:
        assert sha(t.extractfile('runtime125/source.tar').read())==manifest['source_archive_sha256']
    manifest.update(archive=str(archive),archive_sha256=sha(archive.read_bytes()),bytes=archive.stat().st_size)
    (OUT/'candidate-manifest125.json').write_text(json.dumps(manifest,indent=2))
    print('PASS125 recovery kit with pinned124 dependency and exact source archive',flush=True)


if __name__=='__main__':
    collect() if sys.argv[1]=='collect' else package(sys.argv[2])
