"""Capture synthetic test state, archive changed candidates, clean round120 only."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import rehearse_runtime120 as r
from verify_runtime120 import guard


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def capture():
    guard()
    record={}
    for name in (r.HOST,r.DB):
        obj=r.inspect('container',name)
        record[name]=dict(image=obj['Image'],memory=obj['HostConfig']['Memory'],memory_swap=obj['HostConfig']['MemorySwap'],
            cgroup_parent=obj['HostConfig']['CgroupParent'],restarts=obj['RestartCount'],oom_killed=obj['State']['OOMKilled'])
    record['db_state']=r.call('docker','exec',r.DB,'psql','-U','postgres','-d','gps_closure_test','-Atc',
        "SELECT json_build_object('schema',(SELECT max(version) FROM _sqlx_migrations),'temporary_images',(SELECT count(*) FROM privacy_image_payloads),'active_other_queries',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active'),'idle_in_transaction',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state LIKE 'idle in transaction%'))").stdout.strip()
    record['db_state']=json.loads(record['db_state']);assert record['db_state']['temporary_images']==0
    assert record['db_state']['idle_in_transaction']==0
    record['remaining_renderers']=r.inside('pgrep','-x','gps-pdf-render',check=False).stdout.splitlines();assert not record['remaining_renderers']
    record['units']=r.inside('systemctl','show','gps120-api@one','gps120-api@two','gps-pdf-render.socket','gps-pdf-budget.service',
                            '-p','Id','-p','ActiveState','-p','NRestarts','-p','MemoryMax','-p','MemorySwapMax','-p','LimitCORE').stdout
    record['production_changed']=False
    (r.OUT/'final-state.json').write_text(json.dumps(record,indent=2))
    print('PASS final synthetic schema112, no pending renderers/images/open transactions')


def archive(source_commit):
    assert len(source_commit)==40
    # Extracted canonical git archive supplied by the operator, then byte-compare
    # every compiled source and font against what was built. Never fix migrations.
    clean=r.JOB/'canonical';assert clean.is_dir()
    for folder in ('gps-tracker-api','gps-pdf-render','gps-tracker-web/src/assets/fonts'):
        assert (clean/folder).is_dir(),folder
        for p in (clean/folder).rglob('*'):
            if p.is_file():assert p.read_bytes()==(r.JOB/'src'/p.relative_to(clean)).read_bytes(),str(p)
    package=r.JOB/'candidate-runtime120-20261113-r1';assert not package.exists();package.mkdir()
    for name in ('gps-tracker-api','gps-pdf-render'):shutil.copy2(r.OUT/name,package/name)
    for folder in ('gps-tracker-api','gps-pdf-render','gps-tracker-web/src/assets/fonts','ops'):
        shutil.copytree(clean/folder,package/'source'/folder)
    # Generated unit files are configuration candidates, not a production installer.
    units=package/'units';units.mkdir()
    import pdf_runtime120
    class Site:
        units=Path('units');renderer=Path('/home/mmm/projects/gps-tracker-api/bin/gps-pdf-render')
    for path,content in pdf_runtime120.files(Site()).items():
        dest=package/path;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(content)
    (package/'pdf_budget120.py').write_text(pdf_runtime120.budget_script())
    info=dict(release='runtime120-20261113-r1',schema=112,source_commit=source_commit,activation_ready=False,
        production_installer=False,base_candidate='/home/etcom-hub/build/gps-runtime119-20261112/candidate-runtime119-20261112-r1.tar.gz',
        base_sha256='902a2002aeb12befd0a8c385f074d5dff1b911b698c493e071035072a4c198de',
        api_sha256=sha(package/'gps-tracker-api'),pdf_sha256=sha(package/'gps-pdf-render'),
        boundaries=['PDF global lock requires new service mode, shared lock and API status8 support',
            'local child fallback is not globally admitted; production must use service socket',
            '4GiB synthetic aggregate limit is not production capacity acceptance',
            'DB used protected Timescale container; native production DB unit/maintenance/restore integration remains',
            'two API concurrency is PDF-only proof; full multi-API DB connection budget is not accepted',
            'prior encryption, monthly, cumulative and restore evidence remains round119; not rerun in120'])
    (package/'candidate.json').write_text(json.dumps(info,indent=2))
    hashes={str(p.relative_to(package)):sha(p) for p in package.rglob('*') if p.is_file()}
    (package/'manifest.json').write_text(json.dumps(hashes,indent=2))
    target=package.with_suffix('.tar.gz')
    with tarfile.open(target,'w:gz') as tar:tar.add(package,arcname=package.name)
    with tarfile.open(target) as tar:
        for name,digest in hashes.items():assert hashlib.sha256(tar.extractfile(package.name+'/'+name).read()).hexdigest()==digest
    result=dict(**info,archive=str(target),archive_sha256=sha(target),files=len(hashes),bytes=target.stat().st_size)
    (r.OUT/'candidate-manifest.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)


if __name__=='__main__':
    if sys.argv[1]=='capture':capture()
    elif sys.argv[1]=='archive':archive(sys.argv[2])
