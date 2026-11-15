"""Non-secret evidence and pinned dependency kit for the round126 rehearsal."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tarfile
import rehearse_runtime126 as r


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def collect():
    r.base.guard()
    data=json.loads(r.base.call('docker','inspect',r.HOST).stdout)[0]
    assert data['Config']['Labels'].get('gps.runtime126')=='synthetic'
    cfg=data['HostConfig'];net=json.loads(r.base.call('docker','network','inspect',r.NET).stdout)[0]
    assert net['Internal'] and not cfg['Binds'] and not cfg['PortBindings']
    (r.base.OUT/'environment126.json').write_text(json.dumps(dict(image=data['Image'],
        memory=cfg['Memory'],memory_and_swap=cfg['MemorySwap'],nano_cpus=cfg['NanoCpus'],
        binds=cfg['Binds'],ports=cfg['PortBindings'],tmpfs=cfg['Tmpfs'],cap_add=cfg['CapAdd'],
        security_opt=cfg['SecurityOpt'],network_internal=True),indent=2))
    hashes={}
    for name in ('crypto20b_transition.py','location_query_statistics.py','runtime121_control.py','runtime121_job.py',
        'verify_runtime126.py','profile_runtime126.py','perf_runtime126.py','repeat_runtime126.py',
        'test_statistics126.py','uncompressed_perf126.py','regress_runtime126.py'):
        actual=r.base.inside('sha256sum','/opt/gps121/'+name).stdout.split()[0]
        assert actual==sha(r.JOB/'src/ops'/name),name
        hashes[name]=actual
    assert r.base.inside('sha256sum','/opt/gps121/out/gps-tracker-api').stdout.split()[0]==r.prior.API_SHA
    (r.base.OUT/'running-source126.json').write_text(json.dumps(hashes,indent=2))
    units=r.base.OUT/'units';units.mkdir(exist_ok=True)
    for name in ('gps121-db.service','gps121-api.service','gps121-transition.service','gps121-recovery.service',
        'gps121-cleanup.service','gps121-closure.service','gps121-checkpoint.service','gps-pdf-render@.service',
        'gps122-proxy.service','run-gps121-sort.mount','run-gps121-fallback.mount','run-gps121-tmp.mount','gps-workload.slice'):
        (units/name).write_text(r.base.inside('systemctl','cat',name).stdout)
    for name in ('gps121-api','gps121-db'):
        (r.base.OUT/(name+'126.log')).write_text(r.base.inside('journalctl','-u',name,'--no-pager','-o','cat').stdout)
    (r.base.OUT/'mounts126.txt').write_text(r.base.inside('findmnt','-n','-o','TARGET,FSTYPE,OPTIONS','-t','tmpfs').stdout)
    for name in ('transition','recovery','cleanup','closure','checkpoint'):
        target=f'/opt/gps121/job-results/{name}-protection.json'
        if r.base.inside('test','-f',target,check=False).returncode==0:
            r.base.call('docker','cp',r.HOST+':'+target,str(r.base.OUT/(name+'-protection126.json')))
    print('PASS126 isolated environment/unit/log/mount evidence retained',flush=True)


def package(commit):
    r.base.guard();assert re.fullmatch('[0-9a-f]{40}',commit)
    dependency=r.JOB.parent/'gps-runtime125-20261114/recovery-kit-runtime125-20261114-r1.tar.gz'
    assert sha(dependency)=='f469828ce877ffffa555fe9b168200c7e423c0e1228f9a858df5218f67ec6c73'
    stage=r.JOB/'kit';assert not stage.exists();stage.mkdir()
    with tarfile.open(r.JOB/'source-final.tar') as source:
        canonical={m.name:hashlib.sha256(source.extractfile(m).read()).hexdigest() for m in source if m.isfile()}
    assert all(sha(r.JOB/'src'/name)==value for name,value in canonical.items())
    shutil.copytree(r.JOB/'src/ops',stage/'ops',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    shutil.copytree(r.base.OUT/'adapters',stage/'adapters')
    contents={p.relative_to(stage).as_posix():sha(p) for p in stage.rglob('*') if p.is_file()}
    manifest=dict(release='runtime126-20261115-r1',source_commit=commit,schema=113,
        production_installer=False,activation_ready=False,performance_accepted=False,
        dependency=str(dependency),dependency_sha256=sha(dependency),api_sha256=sha(r.base.OUT/'gps-tracker-api'),
        source_archive_sha256=sha(r.JOB/'source-final.tar'),
        pdf_sha256=sha(r.base.OUT/'gps-pdf-render'),contents=contents,
        boundaries=['125 kit and124 API dependency, no new API/schema/web/firmware',
        'synthetic2CPU4GiB128MB DB buffers, not shared3GB production capacity',
        'restore statistics fix verified; compressed history temp-space failure remains',
        'no keys, credentials, backups or plaintext result payloads in kit'])
    (stage/'manifest.json').write_text(json.dumps(manifest,indent=2))
    archive=r.JOB/'recovery-kit-runtime126-20261115-r1.tar.gz'
    assert not archive.exists()
    with tarfile.open(archive,'w:gz') as tar:tar.add(stage,arcname='runtime126')
    with tarfile.open(archive) as tar:
        for name,digest in contents.items():assert hashlib.sha256(tar.extractfile('runtime126/'+name).read()).hexdigest()==digest
    manifest.update(archive=str(archive),archive_sha256=sha(archive),files=len(contents),bytes=archive.stat().st_size)
    (r.base.OUT/'candidate-manifest126.json').write_text(json.dumps(manifest,indent=2))
    print('PASS126 kit, every source hash and pinned dependency; activation_ready=false',flush=True)


if __name__=='__main__':
    collect() if sys.argv[1]=='collect' else package(sys.argv[2])
