"""Collect public test evidence, preserve pinned builds, remove no host files."""
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sys
import tarfile
import re
from rehearse_runtime122 import JOB, HOST, NET, original_call as call, base
from build_cleanup_20261113 import containers, REQUIRED, sha

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
    assert info['Config']['Labels'].get('gps.runtime122')=='synthetic'
    net=json.loads(call('docker','network','inspect',NET).stdout)[0]
    config=info['HostConfig']
    assert net['Internal'] and not config['Binds'] and not config['PortBindings']
    write('environment122',dict(image=info['Image'],internal=True,binds=config['Binds'],ports=config['PortBindings'],
        memory=config['Memory'],memory_swap=config['MemorySwap'],cpu_nano=config['NanoCpus'],
        blkio={k:v for k,v in config.items() if k.startswith('Blkio')},
        cap_add=config['CapAdd'],security_opt=config['SecurityOpt']))
    units=OUT/'units';units.mkdir(exist_ok=True)
    for name in ['gps121-db.service','gps121-api.service','gps121-cleanup.service','gps122-proxy.service',
        'gps122-other.service','gps122-av.service','gps-workload.slice','gps-workload-pdf.slice',
        'run-gps121-sort.mount','run-gps121-fallback.mount','run-gps121-tmp.mount']:
        (units/name).write_text(base.inside('systemctl','cat',name).stdout)
    (OUT/'mounts122.txt').write_text(base.inside('findmnt','-n','-o','TARGET,FSTYPE,OPTIONS','-t','tmpfs').stdout)
    print('PASS public profiles collected; credentials excluded')


def package(commit):
    assert re.fullmatch('[0-9a-f]{40}',commit)
    prior=JOB.parent/'gps-runtime121-20261113/protection-kit-runtime121-20261113-r1.tar.gz'
    assert sha(prior)=='e8208d08c2a1d20a4f6b362713814158eec3aaf627d14a89a5f7744de7acdf07'
    files={str(p.relative_to(JOB/'src')):sha(p) for p in (JOB/'src/ops').rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc'}
    with tarfile.open(JOB/'final-source.tar') as source:
        checked=0
        for member in source.getmembers():
            if member.isfile():
                assert sha(JOB/'src'/member.name)==files[member.name]
                import hashlib
                assert hashlib.sha256(source.extractfile(member).read()).hexdigest()==files[member.name]
                checked+=1
    assert checked==len(files)
    manifest=dict(release='capacity122-20261113-r1',source_commit=commit,schema=112,
        activation_ready=False,production_installer=False,base_kit=str(prior),base_kit_sha256=sha(prior),
        api_sha256=sha(OUT/'gps-tracker-api'),pdf_sha256=sha(OUT/'gps-pdf-render'),
        source_files=checked,contents=files,
        boundaries=['Synthetic native services, two future capacity profiles only',
            'Current3GiB shared production not admitted; read-only observation only',
            'Other services and AV use bounded pressure simulators, not actual project workload or malware scanning',
            '300seconds per profile; no long-duration production assurance',
            'Cleanup128MiB is not a migration or restore capacity qualification'])
    archive=JOB/'capacity-kit-runtime122-20261113-r1.tar.gz'
    assert not archive.exists()
    metadata=JOB/'manifest122.json';metadata.write_text(json.dumps(manifest,indent=2))
    with tarfile.open(archive,'w:gz') as t:
        t.add(metadata,arcname='runtime122/manifest.json')
        for name in files:t.add(JOB/'src'/name,arcname='runtime122/'+name)
    with tarfile.open(archive) as t:
        import hashlib
        for name,digest in files.items():assert hashlib.sha256(t.extractfile('runtime122/'+name).read()).hexdigest()==digest
    manifest.update(archive=str(archive),archive_sha256=sha(archive),bytes=archive.stat().st_size)
    write('candidate-manifest122',manifest)
    print('PASS small dependency kit, canonical source and every archive member hash')


def finish():
    assert call('docker','inspect',HOST,check=False).returncode!=0
    assert call('docker','network','inspect',NET,check=False).returncode!=0
    before=json.loads((OUT/'build-before122.json').read_text());after=snapshot()
    assert before['containers']==after['containers'],'Unrelated container changed'
    write('cleanup122',dict(at=after['at'],unrelated_containers=len(after['containers']),
        unchanged_since=before['at'],prior_artifacts_verified=len(REQUIRED),free_bytes=after['free_bytes'],
        removed_only_labelled_synthetic_container_and_network=True,keys_and_database_removed=True,
        automatic_retention_added=False,production_modified=False))
    print('PASS final environment and preserved artifacts')


if __name__=='__main__':
    action=sys.argv[1];base.guard()
    if action=='before':
        assert not (OUT/'build-before122.json').exists()
        write('build-before122',snapshot())
    elif action=='collect':collect()
    elif action=='package':package(sys.argv[2])
    elif action=='finish':finish()
    else:raise ValueError(action)
