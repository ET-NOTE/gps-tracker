"""Collect non-secret native fixture evidence; create a small dependency kit.

Only fixed labelled synthetic resources and pinned previous build artifacts.
Never includes database dumps, keyrings, unit environments or credentials.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tarfile
from rehearse_runtime121 import JOB, HOST, OUT, guard, call, inside


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def collect():
    guard()
    info=json.loads(call('docker','inspect',HOST).stdout)[0]
    assert info['Config']['Labels']['gps.runtime121']=='synthetic'
    config=info['HostConfig']
    public=dict(image=info['Image'],memory=config['Memory'],memory_and_swap=config['MemorySwap'],
        binds=config['Binds'],ports=config['PortBindings'],cap_add=config['CapAdd'],
        security_opt=config['SecurityOpt'],tmpfs=config['Tmpfs'])
    net=json.loads(call('docker','network','inspect','gps-runtime121-private').stdout)[0]
    public['network_internal']=net['Internal']
    assert public['network_internal'] and not public['binds'] and not public['ports']
    (OUT/'environment121.json').write_text(json.dumps(public,indent=2))
    p=inside('python3','-c',"""
import sys,json,subprocess
sys.path.insert(0,'/opt/gps121')
from pathlib import Path
from runtime121_control import ROOT,DSN,stop_api,drain
import psycopg
stop_api();drain()
with psycopg.connect(DSN,autocommit=True) as db:
 schema=db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()[0]
 plain=db.execute('SELECT count(*) FROM location_records WHERE lat IS NOT NULL OR lng IS NOT NULL OR fixes_jsonb IS NOT NULL').fetchone()[0]
 idle=db.execute("SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction'").fetchone()[0]
 images=db.execute('SELECT count(*) FROM privacy_image_payloads').fetchone()[0]
 renderers=sum(p.read_text().strip()=='gps-pdf-render' for p in Path('/proc').glob('[0-9]*/comm') if p.exists())
 assert schema==112 and plain==0 and idle==0 and renderers==0 and images==0
 result=dict(schema=schema,plaintext_locations=plain,idle_transactions=idle,renderers=renderers,redacted_images=images,production_modified=False,activation_ready=False)
 print(json.dumps(result))
""")
    (OUT/'final-state121.json').write_text(p.stdout)
    units=OUT/'units';units.mkdir(exist_ok=True)
    for name in ('gps121-db.service','gps121-api.service','gps121-migration.service',
        'gps121-transition.service','gps121-cleanup.service','gps121-closure.service',
        'gps121-recovery.service','gps121-checkpoint.service','gps121-underlay.service',
        'gps121-temp-ready.service','run-gps121-sort.mount','run-gps121-fallback.mount',
        'run-gps121-tmp.mount','gps-workload.slice','gps-workload-pdf.slice'):
        (units/name).write_text(inside('systemctl','cat',name).stdout)
    # These files contain permissions/UID booleans, never credential values.
    for kind in ('transition','cleanup','closure','recovery','checkpoint'):
        call('docker','cp',HOST+':/opt/gps121/job-results/'+kind+'-protection.json',str(OUT/(kind+'-credentials.json')))
    (OUT/'mounts121.txt').write_text(inside('findmnt','-n','-o','TARGET,FSTYPE,OPTIONS','-t','tmpfs').stdout)
    print('PASS native final state, unit/mount profiles and credential boundary evidence',flush=True)


def package(commit):
    guard();assert re.fullmatch('[0-9a-f]{40}',commit)
    prior=JOB.parent/'gps-runtime120-20261113/candidate-runtime120-20261113-r1.tar.gz'
    prior_sha='3b4bfa22719081d7a6f11448f23cb86f6cbfad4c0175aaea78dc5346e426bd33'
    assert sha(prior)==prior_sha
    stage=JOB/'kit';assert not stage.exists()
    stage.mkdir()
    # Complete small ops source avoids copying unchanged binaries for every round.
    shutil.copytree(JOB/'src/ops',stage/'ops',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    files={str(p.relative_to(stage)):sha(p) for p in stage.rglob('*') if p.is_file()}
    manifest=dict(release='runtime121-20261113-r1',source_commit=commit,schema=112,
        production_installer=False,activation_ready=False,base_candidate=str(prior),base_sha256=prior_sha,
        api_sha256=sha(OUT/'gps-tracker-api'),pdf_sha256=sha(OUT/'gps-pdf-render'),
        baseline99_sha256=sha(OUT/'gps-tracker-api.baseline99'),
        package_sha256={p.name:sha(p) for p in (JOB/'packages').glob('*.deb')},
        contents=files,boundaries=[
            'Synthetic native systemd/PG14/Timescale2.19.3 rehearsal only; no production application',
            '4096MiB and shared_buffers128MB are not the shared 3GiB production capacity acceptance',
            'Transition root with limited CHOWN/DAC_OVERRIDE; recovery/checkpoint postgres fixture identity',
            'No monthly sustained-load requalification or production old WAL/backup retirement',
            'Unchanged API/PDF reused from pinned120; fixture dependency kit, not standalone99 installer'])
    (stage/'manifest.json').write_text(json.dumps(manifest,indent=2))
    archive=JOB/'protection-kit-runtime121-20261113-r1.tar.gz'
    assert not archive.exists()
    with tarfile.open(archive,'w:gz') as t:t.add(stage,arcname='runtime121')
    with tarfile.open(archive) as t:
        for name,digest in files.items():
            assert hashlib.sha256(t.extractfile('runtime121/'+name).read()).hexdigest()==digest
    manifest.update(archive=str(archive),archive_sha256=sha(archive),files=len(files),bytes=archive.stat().st_size)
    (OUT/'candidate-manifest121.json').write_text(json.dumps(manifest,indent=2))
    print('PASS protection kit and every member hash; pinned120 dependency; activation_ready=false',flush=True)


if __name__=='__main__':
    collect() if sys.argv[1]=='collect' else package(sys.argv[2])
