"""Fixed synthetic119 snapshot, artifact packaging and cleanup. Never deploys."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
from datetime import datetime, timezone

ROOT=Path('/home/etcom-hub/build')
KIT=ROOT/'gps-runtime119-20261112'
CUM=ROOT/'gps-provision22-20261112cumulative119'
BENCH=ROOT/'gps-provision22-20261112runtime119'
assert subprocess.check_output(['hostname'],text=True).strip()=='etcom-hub'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()


def command(*args): return subprocess.check_output(args,text=True).strip()


def save(name,value):
    (KIT/'out'/name).write_text(json.dumps(value,indent=2)+'\n')


def snapshot():
    result={'utc':datetime.now(timezone.utc).isoformat(),'production_modified':False,'containers':{},'databases':{}}
    names=command('docker','ps','-aq','--filter','label=gps.runtime119=synthetic').splitlines()
    for cid in names:
        info=json.loads(command('docker','inspect',cid))[0]
        name=info['Name'].lstrip('/')
        assert name.startswith(('gps-runtime119-','gps-provision22-')) and not info['HostConfig']['PortBindings']
        state={k:info['State'][k] for k in ('Running','OOMKilled','ExitCode','StartedAt')}
        assert state['Running'] and not state['OOMKilled'],name
        row={'image_id':info['Image'],'state':state,'restart_count':info['RestartCount'],
            'limits':{k:info['HostConfig'][k] for k in ('Memory','MemorySwap','NanoCpus','Ulimits','Tmpfs')},
            'cgroup':{k:command('docker','exec',cid,'cat','/sys/fs/cgroup/'+k) for k in
                      ('memory.max','memory.swap.max','memory.swap.current','memory.events','io.max')}}
        assert row['cgroup']['memory.swap.max']=='0' and row['cgroup']['memory.swap.current']=='0'
        assert dict(x.split() for x in row['cgroup']['memory.events'].splitlines())['oom_kill']=='0',name
        if name!='gps-runtime119-pdf-host':
            row['exec_dumpable']=int(command('docker','exec',cid,'python3','-c','import ctypes;print(ctypes.CDLL(None).prctl(3,0,0,0,0))'))
            assert row['exec_dumpable']==0
            row['guard_files']=command('docker','exec',cid,'sha256sum','/usr/local/lib/runtime119_entry.py',
                '/usr/local/lib/runtime119_profiles.py','/usr/local/lib/gps-nodump.so')
        result['containers'][name]=row
    for name,db in [('gps-provision22-db-20261112cumulative119','gps_closure_test'),('gps-runtime119-db','gps_runtime119_test')]:
        query="""SELECT json_build_object('schema',(SELECT max(version) FROM _sqlx_migrations),
            'records',(SELECT count(*) FROM location_records),
            'plaintext_rows',(SELECT count(*) FROM location_records WHERE lat IS NOT NULL OR lng IS NOT NULL OR fixes_jsonb IS NOT NULL),
            'encrypted_rows',(SELECT count(*) FROM location_records WHERE lat_sealed IS NOT NULL),
            'pending_bounds',(SELECT count(*) FROM location_records WHERE NOT query_bounds_ready),
            'active_reads',(SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'gps-read-%'),
            'idle_transactions',(SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction'),
            'settings',(SELECT json_agg(t) FROM (SELECT name,setting,unit FROM pg_settings WHERE name IN
            ('shared_buffers','work_mem','max_connections','jit','temp_tablespaces','temp_file_limit') ORDER BY name)t))"""
        value=json.loads(command('docker','exec',name,'psql','-X','-U','postgres','-d',db,'-Atc',query))
        assert value['schema']==112 and value['plaintext_rows']==value['pending_bounds']==value['active_reads']==value['idle_transactions']==0
        assert value['records']==value['encrypted_rows']
        result['databases'][name]=value
    save('final-state119.json',result)
    print('PASS final encrypted state, no residual reads, no OOM or swap',flush=True)


def package():
    target=KIT/'candidate-runtime119-20261112-r1'
    assert not target.exists()
    target.mkdir()
    for name in ('gps-tracker-api','gps-pdf-render'): shutil.copy2(KIT/'out'/name,target/name)
    assert sha(target/'gps-tracker-api')=='a4435f248d1ec1307ba7beec62da084bdf2899fb26e0d1e2b16d4507d7765f23'
    assert sha(target/'gps-pdf-render')=='048cffd2113dd03c415cd777746b02358930c5e9c4015317bad00404fe5b4e3f'
    shutil.copytree(CUM/'out/web-root',target/'web-root')
    shutil.copytree(CUM/'out/web-subpath',target/'web-subpath')
    shutil.copytree(KIT/'src/gps-tracker-api',target/'source/gps-tracker-api')
    shutil.copytree(KIT/'gps-pdf-render',target/'source/gps-pdf-render',ignore=shutil.ignore_patterns('target','.git'))
    shutil.copytree(KIT/'gps-tracker-web/src/assets/fonts',target/'source/gps-tracker-web/src/assets/fonts')
    shutil.copytree(KIT/'src/ops',target/'source/ops')
    # Reviewed119 ops overlay; never copy one-off helpers or private fixture files.
    for p in (KIT/'ops').iterdir():
        if p.is_file() and ('runtime119' in p.name or p.name in ('verify_process119.py','verify_pdf_service119.py','prepare_cumulative116.py')):
            shutil.copy2(p,target/'source/ops'/p.name)
    for name in ('runtime118_guard.py','runtime118_nodump.c'):
        assert (target/'source/ops'/name).exists()
    files={str(p.relative_to(target)):sha(p) for p in target.rglob('*') if p.is_file()}
    manifest={'release':'runtime119-20261112-r1','schema':112,'activation_ready':False,'production_modified':False,
        'api_source_commit':'396696847d1281a821f9313cea30e5726a8b2267',
        'api_source_note':'Canonical git archive; exact compilation bytes in source/gps-tracker-api. API source unchanged in119.',
        'prior117_api_superseded_for_cumulative_upgrade':True,
        'web_unchanged_from116':True,'not_production_installer':True,
        'open_gates':['shared RAM/connections incl on-demand PDF and AV','production unit integration and maintenance rehearsal',
                      'policy/key/rights checkpoint and operational acceptance','existing held physical/security items'],
        'files':files}
    (target/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    archive=KIT/(target.name+'.tar.gz')
    with tarfile.open(archive,'w:gz') as tar: tar.add(target,arcname=target.name)
    with tarfile.open(archive) as tar:
        for path,digest in files.items(): assert hashlib.sha256(tar.extractfile(target.name+'/'+path).read()).hexdigest()==digest,path
    save('package119.json',{'archive':str(archive),'sha256':sha(archive),'files_verified':len(files),'manifest':manifest})
    print('PASS candidate archive bytes verified; activation disabled',flush=True)


def cleanup():
    assert (KIT/'out/final-state119.json').exists() and (KIT/'out/package119.json').exists()
    nets=['gps-provision22-test-20261112cumulative119','gps-runtime119-test']
    allowed={'gps-provision22-db-20261112cumulative119','gps-provision22-api-20261112cumulative119',
             'gps-runtime119-db','gps-runtime119-api','gps-runtime119-api2','gps-runtime119-proxy','gps-runtime119-pdf-host'}
    ids=command('docker','ps','-aq','--filter','label=gps.runtime119=synthetic').splitlines()
    removed=[]
    for cid in ids:
        value=json.loads(command('docker','inspect',cid))[0];name=value['Name'].lstrip('/')
        assert name in allowed and value['Config']['Labels']['gps.runtime119']=='synthetic'
        command('docker','rm','-f',cid);removed.append(name)
    for name in nets:
        value=json.loads(command('docker','network','inspect',name))[0]
        assert value['Internal'] and value['Labels']['gps.runtime119']=='synthetic' and not value['Containers']
        command('docker','network','rm',name)
    for name in ('gps-runtime119-data','gps-runtime119-pdf-socket'):
        value=json.loads(command('docker','volume','inspect',name))[0]
        assert value['Labels']['gps.runtime119']=='synthetic'
        command('docker','volume','rm',name)
    private=[]
    jobs=[CUM,BENCH,ROOT/'gps-provision22-20261112cumulative119-checksum-rejected',
          ROOT/'gps-provision22-20261112cumulative119-recovery-1500m-oom',ROOT/'gps-provision22-20261112runtime119-seed-dependency-failed']
    for job in jobs:
        assert job.resolve().parent==ROOT and job.name.startswith('gps-provision22-20261112')
        for name in ('test-keys.json','test-runtime.json','regression.env','test-storage','tls','storage-gps-runtime119-api','storage-gps-runtime119-api2'):
            p=job/name
            if not p.exists():continue
            assert not p.is_symlink() and p.resolve().parent==job
            if p.is_dir():shutil.rmtree(p)
            else:p.unlink()
            private.append(str(p))
    assert not command('docker','ps','-aq','--filter','label=gps.runtime119=synthetic')
    save('cleanup119.json',{'production_modified':False,'containers_removed':removed,'networks_removed':nets,
                          'private_paths_removed':private,'free_bytes':shutil.disk_usage(ROOT).free})
    print('PASS fixed synthetic resources and keys removed; evidence and artifacts retained',flush=True)


if __name__=='__main__': {'snapshot':snapshot,'package':package,'cleanup':cleanup}[sys.argv[1]]()
