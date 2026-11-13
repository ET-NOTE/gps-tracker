"""Native unit fault checks after encrypted cumulative/API regression."""
import json
import os
from pathlib import Path
import subprocess
import time
import psycopg
from runtime121_control import ROOT, DSN, boot_new, stop_api, transition, job, drain

assert Path('/etc/runtime121-test-only').read_text().strip()=='synthetic'
ring=json.loads((ROOT/'test-keys.json').read_text())
cred=json.loads((ROOT/'test-runtime.json').read_text())
runtime=DSN.replace('postgres:closure-test-only',cred['user']+':'+cred['password'])
cfg=dict(DATABASE_URL=runtime,GPS_LOCATION_ENCRYPTION='pilot',GPS_LOCATION_KEYRING_FILE=str(ROOT/'api-keyring.json'),
         UPLOAD_DIR=str(ROOT/'test-storage/uploads'),PRIVATE_UPLOAD_DIR=str(ROOT/'test-storage/private'))
env=dict(STORAGE='pilot',RUNTIME_DSN=runtime)
results=[]


def cmd(*args,check=True):
    return subprocess.run(args,check=check,capture_output=True,text=True).stdout.strip()


def record(name,**data):
    results.append(dict(check=name,**data));(ROOT/'out/runtime-faults121.json').write_text(json.dumps(results,indent=2))
    print('PASS '+name,flush=True)


def no_db():
    for _ in range(100):
        p=subprocess.run(['pg_isready'],capture_output=True)
        if p.returncode!=0:return
        time.sleep(.1)
    raise AssertionError('database remained ready after mount loss')


def wait_db():
    for _ in range(100):
        if subprocess.run(['pg_isready'],capture_output=True).returncode==0:return
        time.sleep(.1)
    raise AssertionError('database not ready')


stop_api();drain()
transition(DSN,ring,str(ROOT/'test-storage/uploads'),str(ROOT/'test-storage/private'),'resume')
job('cleanup',worker=cfg);job('closure',worker=cfg)
boot_new(env)
names=['db','api','migration','transition','cleanup','closure','recovery','checkpoint']
properties={}
for name in names:
    values=dict(line.split('=',1) for line in cmd('systemctl','show','gps121-'+name,
        '-p','User,MemoryMax,MemorySwapMax,LimitCORE,Slice,BindsTo,BindPaths,CapabilityBoundingSet,NoNewPrivileges').splitlines())
    assert values['MemorySwapMax']=='0' and values['LimitCORE']=='0' and values['NoNewPrivileges']=='yes'
    assert values['Slice']=='gps-workload.slice'
    assert all('run-gps121-'+x+'.mount' in values['BindsTo'] for x in ('tmp','sort','fallback'))
    properties[name]=values
record('all native data-processing units share memory, no-swap, no-core and mount dependencies',units=properties)

# A real protected worker deletes one explicitly queued synthetic encrypted file.
p=ROOT/'test-storage/uploads/device_documents/1/1/cleanup121.bin'
p.write_bytes(b'GPSFILE1\n'+b'synthetic deletion fixture')
import pwd
uid=pwd.getpwnam('gps-api').pw_uid
os.chown(p,uid,uid)
with psycopg.connect(DSN,autocommit=True) as db:
    qid=db.execute("INSERT INTO privacy_file_cleanup(storage_kind,storage_key,reason,source_table,source_id) VALUES('document',%s,'runtime121','synthetic',121) RETURNING id",(str(p),)).fetchone()[0]
for _ in range(30):
    result=job('cleanup',worker=cfg)
    assert result['processed'] is not None
    if result['processed']['job_id']==qid:break
else:raise AssertionError('synthetic cleanup job not reached')
assert not p.exists() and result['processed']['state']=='local_absent'
record('non-root cleanup unit removes only queued synthetic file and records local absence',result=result)

# Bad profile must reject before any recovery operation executes.
plan=Path('/etc/gps121/job.json');original=plan.read_text()
bad=json.loads(original);bad['library_sha256']='0'*64;plan.write_text(json.dumps(bad))
try:
    try:job('recovery',action='dump',database='gps_closure_test')
    except RuntimeError as e:assert 'hash mismatch' in str(e)
    else:raise AssertionError('unsafe recovery started')
finally:plan.write_text(original)
record('recovery job refuses an invalid protection library hash')

for name in ('sort','fallback','tmp'):
    unit='run-gps121-'+name+'.mount'
    cmd('systemctl','stop',unit)
    no_db()
    assert cmd('systemctl','is-active','gps121-api',check=False)!='active'
    for user in ('postgres','gps-api'):
        denial=subprocess.run(['sudo','-u',user,'touch','/run/gps121/'+name+'/must-not-exist'],capture_output=True)
        assert denial.returncode!=0
    source=Path('/etc/systemd/system')/unit;held=source.with_suffix('.held')
    source.rename(held)
    cmd('systemctl','mask',unit);cmd('systemctl','daemon-reload')
    try:
        attempt=subprocess.run(['systemctl','start','gps121-db'],capture_output=True)
        assert attempt.returncode!=0
    finally:
        cmd('systemctl','unmask',unit);held.rename(source);cmd('systemctl','daemon-reload');cmd('systemctl','reset-failed')
    cmd('systemctl','start','gps121-db');wait_db();boot_new(env)
    with psycopg.connect(DSN,autocommit=True) as db:
        assert db.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()==(112,)
    record('mount loss stops API/DB and missing mount prevents restart: '+name)

stop_api();drain()
job('cleanup',worker=cfg);job('closure',worker=cfg)
record('protected cleanup and closure units recover after temporary mount reconstruction')
snapshot={}
for label,path in [('all','/sys/fs/cgroup/gps.slice/gps-workload.slice'),('pdf','/sys/fs/cgroup/gps.slice/gps-workload.slice/gps-workload-pdf.slice')]:
    p=Path(path)
    if p.is_dir():
        snapshot[label]={x:(p/x).read_text().strip() for x in ('memory.current','memory.peak','memory.swap.current','memory.events') if (p/x).exists()}
(ROOT/'out/resources121.json').write_text(json.dumps(snapshot,indent=2))
assert snapshot and all(dict(line.split() for line in value['memory.events'].splitlines())['oom_kill']=='0' for value in snapshot.values())
assert all(value['memory.swap.current']=='0' for value in snapshot.values())
record('normal fault suite completed without uncontrolled disk fallback',resource_snapshot=snapshot)
