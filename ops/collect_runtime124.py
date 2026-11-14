"""Collect public test evidence, preserve pinned builds, remove no host files."""
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sys
import tarfile
import re
from rehearse_runtime124 import JOB, HOST, NET, original_call as call, base
from build_cleanup_20261113 import containers, protected, REQUIRED, sha

OUT=JOB/'out'


def write(name, value):
    (OUT/(name+'.json')).write_text(json.dumps(value,indent=2)+'\n')


def snapshot():
    state=[x for x in containers() if x['name']!='/'+HOST]
    for name,digest in REQUIRED.items():assert sha(JOB.parent/name)==digest,name
    return dict(at=datetime.now(timezone.utc).isoformat(),containers=state,
        prior_hashes=REQUIRED,free_bytes=shutil.disk_usage(JOB).free)


def collect():
    info=json.loads(call('docker','inspect',HOST).stdout)[0]
    assert info['Config']['Labels'].get('gps.runtime124')=='synthetic'
    net=json.loads(call('docker','network','inspect',NET).stdout)[0]
    config=info['HostConfig']
    assert net['Internal'] and not config['Binds'] and not config['PortBindings']
    write('environment124',dict(image=info['Image'],internal=True,binds=config['Binds'],ports=config['PortBindings'],
        memory=config['Memory'],memory_swap=config['MemorySwap'],cpu_nano=config['NanoCpus'],
        blkio={k:v for k,v in config.items() if k.startswith('Blkio')},
        cap_add=config['CapAdd'],security_opt=config['SecurityOpt']))
    source_hashes={}
    for name in ('load_runtime124.py','verify_runtime124.py','load_runtime122.py','verify_runtime122.py','profile_runtime124.py','profile_trial124.py','verify_query124.py','privacy_file_cleanup.py','runtime121_control.py','runtime121_job.py'):
        actual=base.inside('sha256sum','/opt/gps121/'+name).stdout.split()[0]
        assert actual==sha(JOB/'src/ops'/name),name
        source_hashes[name]=actual
    write('running-source124',source_hashes)
    units=OUT/'units';units.mkdir(exist_ok=True)
    for name in ['gps121-db.service','gps121-api.service','gps121-cleanup.service','gps122-proxy.service',
        'gps122-other.service','gps122-av.service','gps-workload.slice','gps-workload-pdf.slice',
        'run-gps121-sort.mount','run-gps121-fallback.mount','run-gps121-tmp.mount']:
        (units/name).write_text(base.inside('systemctl','cat',name).stdout)
    (OUT/'mounts124.txt').write_text(base.inside('findmnt','-n','-o','TARGET,FSTYPE,OPTIONS','-t','tmpfs').stdout)
    print('PASS public profiles collected; credentials excluded')


def package(commit):
    assert re.fullmatch('[0-9a-f]{40}',commit)
    prior=JOB.parent/'gps-runtime122-20261113/capacity-kit-runtime122-20261113-r1.tar.gz'
    assert sha(prior)=='2ee26671004a6ab8a19b2033925174e81298fc02fc5dd905294b4dc3e7c83f0f'
    files={str(p.relative_to(JOB/'src')):sha(p) for folder in ('ops','gps-tracker-api') for p in (JOB/'src'/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc'}
    with tarfile.open(JOB/'final-source.tar') as source:
        import hashlib
        expected={m.name:hashlib.sha256(source.extractfile(m).read()).hexdigest() for m in source if m.isfile()}
    assert files==expected
    with tarfile.open(JOB/'canonical.tar') as built:
        for m in built:
            if m.isfile() and m.name.startswith('gps-tracker-api/'):
                assert hashlib.sha256(built.extractfile(m).read()).hexdigest()==files[m.name]
    manifest=dict(release='runtime124-20261114-r1',source_commit=commit,schema=113,
        activation_ready=False,production_installer=False,base_kit=str(prior),base_kit_sha256=sha(prior),
        api_build_commit=(JOB/'api-build-commit.txt').read_text().strip(),
        api_build_archive_sha256=sha(JOB/'canonical.tar'),source_archive_sha256=sha(JOB/'final-source.tar'),
        api_sha256=sha(OUT/'gps-tracker-api'),pdf_sha256=sha(OUT/'gps-pdf-render'),
        source_files=len(files),contents=files,
        boundaries=['Synthetic native protected services, warm database cache',
            'Current3GiB shared production not admitted; no production changes',
            'Other projects and AV are pressure simulators, not real workload',
            'Dedicated two300-second runs per variant, shared one300-second pair; sequential synthetic comparison',
            'Migration113 changes functions only; incremental112to113 tested, full99to113 recovery remains open', 'No web or firmware change'])
    archive=JOB/'candidate-runtime124-20261114-r1.tar.gz'
    assert not archive.exists()
    metadata=JOB/'manifest124.json';metadata.write_text(json.dumps(manifest,indent=2))
    with tarfile.open(archive,'w:gz') as t:
        t.add(metadata,arcname='runtime124/manifest.json')
        t.add(OUT/'gps-tracker-api',arcname='runtime124/gps-tracker-api')
        for name in files:t.add(JOB/'src'/name,arcname='runtime124/src/'+name)
    with tarfile.open(archive) as t:
        for name,digest in files.items():assert hashlib.sha256(t.extractfile('runtime124/src/'+name).read()).hexdigest()==digest
        assert hashlib.sha256(t.extractfile('runtime124/gps-tracker-api').read()).hexdigest()==manifest['api_sha256']
    manifest.update(archive=str(archive),archive_sha256=sha(archive),bytes=archive.stat().st_size)
    write('candidate-manifest124',manifest)
    print('PASS canonical API/source candidate, dependency hash, activation false')


def finish():
    assert call('docker','inspect',HOST,check=False).returncode!=0
    assert call('docker','network','inspect',NET,check=False).returncode!=0
    before=json.loads((OUT/'cache-cleanup124.json').read_text());after=snapshot()
    assert before['containers']==after['containers'],'Unrelated container changed'
    retained=json.loads((OUT/'prior-artifacts124.json').read_text())
    current={k:v for k,v in protected().items() if not k.startswith(JOB.name+'/')}
    assert retained==current,'Prior retained build artifact changed'
    write('cleanup124',dict(at=after['at'],unrelated_containers=len(after['containers']),
        unchanged_since=before['at'],prior_artifacts_verified=len(REQUIRED),free_bytes=after['free_bytes'],
        retained_files_verified=len(retained),retained_hashes_unchanged=True,
        removed_only_labelled_synthetic_container_and_network=True,keys_and_database_removed=True,
        automatic_retention_added=False,production_modified=False))
    print('PASS final environment and preserved artifacts')


if __name__=='__main__':
    action=sys.argv[1];base.guard()
    if action=='before':
        assert not (OUT/'build-before124.json').exists()
        write('build-before124',snapshot())
    elif action=='collect':collect()
    elif action=='package':package(sys.argv[2])
    elif action=='finish':finish()
    else:raise ValueError(action)
